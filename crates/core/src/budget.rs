//! The budget for view work per commit: a commit may rebuild and re-check only the threads
//! it touched, so its cost follows what it changed, not the size of the mailbox.
//!
//! The test fills a large mailbox, keeps open what the app keeps open (the accounts, the
//! mailboxes, the inbox's first page, the People screen's first page filtered by turn, and
//! one conversation), then counts the work (see work.rs) of each step a person causes. It
//! counts instead of timing, so it gives the same answer on every machine.
//!
//! `pnpm bench:scale` times the same steps at 100k messages, for people to read.

use std::cell::RefCell;
use std::rc::Rc;

use chrono::{DateTime, SecondsFormat};
use letterbox_protocol::{AccountId, ChangeId, ChangeResult, CoreMessage, Role, ThreadId};
use serde_json::{Value, json};
use tokio::task::LocalSet;

use crate::adapter::{
    AdapterCapabilities, MailboxRef, MessageRef, RemoteAddress, RemoteFacts, RemoteHeaders, RemoteMailbox,
    RemoteMessage, RemoteState,
};
use crate::clock::FixedEnvironment;
use crate::reconcile::{Incoming, reconcile};
use crate::secrets::{Secrets, SecretsError};
use crate::work::Work;
use crate::world::{AccountRecord, ChangeOutcome, Health, put_account, put_change};
use crate::{Core, CoreOptions};

/// Large enough that a view which reads every thread costs thousands of rows per commit.
const MESSAGES: usize = 20_000;
/// The thread lists the test keeps open. Each may check a touched thread against its filter.
const LISTS: u64 = 2;
const DELIVERED: usize = 200;
const ME: &str = "me@example.com";

struct NoSecrets;

impl Secrets for NoSecrets {
    fn read(&self, _: &AccountId) -> Result<Option<String>, SecretsError> {
        Ok(None)
    }
    fn write(&self, _: &AccountId, _: &str) -> Result<(), SecretsError> {
        Ok(())
    }
    fn delete(&self, _: &AccountId) -> Result<(), SecretsError> {
        Ok(())
    }
}

fn address(address: String) -> RemoteAddress {
    RemoteAddress { name: None, address }
}

/// Message `index`, at `place` in `conversation`, shaped like the bench's mailbox
/// (packages/harness/src/bench.ts): every second message is mine, every seventh
/// conversation is a newsletter, and every fifth carries a label.
fn message(index: usize, conversation: usize, place: usize) -> RemoteMessage {
    let other = format!("person{}@example.com", conversation % 300);
    let mine = place % 2 == 1;
    let mailboxes = if mine {
        vec!["sent".to_owned()]
    } else if conversation.is_multiple_of(5) {
        vec!["inbox".to_owned(), format!("label-{}", conversation % 10)]
    } else {
        vec!["inbox".to_owned()]
    };
    let minutes = i64::try_from(index).expect("the test mailbox is small") * 60;
    let sent_at = DateTime::from_timestamp(1_735_689_600 + minutes, 0).expect("a time in range");
    let (from, to) = if mine {
        (ME.to_owned(), other)
    } else {
        (other, ME.to_owned())
    };
    RemoteMessage {
        state: RemoteState {
            r#ref: MessageRef::new(format!("m{index}")),
            mailboxes: mailboxes.into_iter().map(MailboxRef::new).collect(),
            unread: index.is_multiple_of(3),
            flagged: false,
        },
        facts: RemoteFacts {
            message_id: Some(format!("m{index}")),
            references: if place > 0 {
                vec![format!("m{}", index - 1)]
            } else {
                vec![]
            },
            subject: if place == 0 {
                format!("Topic {conversation}")
            } else {
                format!("Re: Topic {conversation}")
            },
            from: address(from),
            to: vec![address(to)],
            cc: vec![],
            sent_at: sent_at.to_rfc3339_opts(SecondsFormat::Millis, true),
            preview: format!("Message m{index} about topic {conversation}."),
            size: 1000,
            has_attachments: false,
            headers: RemoteHeaders {
                list_unsubscribe: conversation.is_multiple_of(7),
                list_id: false,
                precedence: String::new(),
                auto_submitted: String::new(),
            },
            bulk: None,
        },
    }
}

/// The mailbox: conversations of one to four messages, `size` messages in all.
/// Returns them and the number of conversations.
fn mailbox(size: usize) -> (Vec<RemoteMessage>, usize) {
    let mut messages = Vec::with_capacity(size);
    let mut conversation = 0;
    while messages.len() < size {
        let length = 1 + conversation % 4;
        for place in 0..length {
            if messages.len() == size {
                break;
            }
            messages.push(message(messages.len(), conversation, place));
        }
        conversation += 1;
    }
    (messages, conversation)
}

fn folders() -> Vec<RemoteMailbox> {
    let roles = [
        ("inbox", Some(Role::Inbox)),
        ("sent", Some(Role::Sent)),
        ("archive", Some(Role::Archive)),
        ("trash", Some(Role::Trash)),
    ];
    let labels = (0..10).map(|index| (format!("label-{index}"), None));
    roles
        .into_iter()
        .map(|(name, role)| (name.to_owned(), role))
        .chain(labels)
        .map(|(name, role)| RemoteMailbox {
            r#ref: MailboxRef::new(name.clone()),
            name,
            role,
            parent: None,
        })
        .collect()
}

/// A core over a fresh store, and the messages it has sent.
fn start(folder: &std::path::Path) -> (Core, Rc<RefCell<Vec<CoreMessage>>>) {
    let sent = Rc::new(RefCell::new(Vec::new()));
    let sink = Rc::clone(&sent);
    let core = Core::open(CoreOptions {
        data_path: folder.to_path_buf(),
        env: Box::new(FixedEnvironment::new("2026-01-01T00:00:00.000Z").expect("a valid start time")),
        secrets: Box::new(NoSecrets),
        factories: vec![],
        undo_window: std::time::Duration::from_secs(10),
        confirm_window: std::time::Duration::from_secs(120),
        send: Box::new(move |message| sink.borrow_mut().push(message)),
    })
    .expect("the store opens");
    (core, sent)
}

/// One step a person causes, the work it took, and the most work the budget allows it.
struct Step {
    name: &'static str,
    work: Work,
    touched: u64,
}

impl Step {
    fn over_budget(&self) -> Option<String> {
        let allowed = Work {
            summarized: self.touched,
            matched: self.touched * LISTS,
        };
        (self.work.summarized > allowed.summarized || self.work.matched > allowed.matched).then(|| {
            format!(
                "{}: touched {} thread(s), summarized {} (budget {}) and matched {} against list filters (budget {})",
                self.name, self.touched, self.work.summarized, allowed.summarized, self.work.matched, allowed.matched
            )
        })
    }
}

#[test]
fn a_commit_costs_what_it_touched_not_the_mailbox() {
    let folder = std::env::temp_dir().join(format!("letterbox-budget-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&folder);
    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .expect("a runtime");
    let steps = LocalSet::new().block_on(&runtime, async {
        let (core, sent) = start(&folder);
        let inner = &core.inner;
        let (messages, conversations) = mailbox(MESSAGES);
        let account_id: AccountId = inner.store.next_id();
        inner.commit(|world, tx, _| {
            put_account(
                world,
                tx,
                AccountRecord {
                    id: account_id.clone(),
                    address: ME.to_owned(),
                    provider_label: "Test".to_owned(),
                    factory_id: "test".to_owned(),
                    signed_in: false,
                    capabilities: AdapterCapabilities {
                        modify: true,
                        send: true,
                        multiple_mailboxes: true,
                    },
                    cursor: None,
                    round: 0,
                    snapshot: None,
                    last_synced_at: None,
                    health: Health::Ok,
                },
            );
            let incoming = Incoming {
                page_of: None,
                mailboxes: Some(folders()),
                added: messages,
                updated: vec![],
                removed: vec![],
            };
            reconcile(world, tx, &account_id, incoming);
        });

        let receive = |message: Value| core.receive(message);
        receive(json!({ "kind": "hello", "protocol": letterbox_protocol::PROTOCOL }));
        let views = [
            json!({ "view": "accounts" }),
            json!({ "view": "mailboxes" }),
            json!({ "view": "threads", "filter": {}, "offset": 0, "limit": 50 }),
            json!({ "view": "threads", "filter": { "turn": "mine" }, "offset": 0, "limit": 50 }),
        ];
        for (index, query) in views.into_iter().enumerate() {
            receive(json!({ "kind": "subscribe", "sub": format!("sub_{index}"), "query": query }));
        }
        let newest: ThreadId = {
            let state = inner.state.borrow();
            assert_eq!(
                state.world.threads.len(),
                conversations,
                "every conversation became one thread"
            );
            state
                .world
                .threads
                .keys()
                .last()
                .cloned()
                .expect("the mailbox has threads")
        };

        let mut steps = Vec::new();
        let mut measure = |name, touched, step: &dyn Fn()| {
            let before = inner.meter.read();
            step();
            steps.push(Step {
                name,
                work: inner.meter.read() - before,
                touched,
            });
        };

        measure("open a conversation", 0, &|| {
            receive(
                json!({ "kind": "subscribe", "sub": "sub_open", "query": { "view": "thread", "threadId": newest } }),
            );
        });
        measure("one command", 1, &|| {
            receive(json!({
                "kind": "command",
                "change": "change_1",
                "command": { "kind": "set-flags", "threadIds": [newest], "flagged": true },
            }));
        });
        measure("the command settles", 1, &|| {
            let change = inner
                .state
                .borrow()
                .world
                .changes
                .get(&ChangeId::new("change_1"))
                .cloned();
            let change = change.expect("the command was accepted");
            inner.commit(|world, tx, at| {
                let outcome = Some(ChangeOutcome {
                    rev: at,
                    result: ChangeResult::Done,
                });
                put_change(world, tx, crate::world::ChangeRecord { outcome, ..change });
            });
        });
        let answered = inner
            .state
            .borrow()
            .world
            .messages_by_thread
            .get(&newest)
            .and_then(|ids| ids.first().cloned());
        measure("send a reply", 1, &|| {
            receive(json!({
                "kind": "command",
                "change": "change_2",
                "command": { "kind": "send", "draft": {
                    "accountId": account_id, "to": ["person1@example.com"], "cc": [], "bcc": [],
                    "subject": "Re: a topic", "text": "Yes.", "html": null, "inReplyTo": answered,
                } },
            }));
        });
        let accepted = inner
            .state
            .borrow()
            .world
            .changes
            .contains_key(&ChangeId::new("change_2"));
        assert!(accepted, "the reply was accepted, so its step measured a real send");
        let delivered = (0..DELIVERED)
            .map(|index| message(MESSAGES + index, conversations + index, 0))
            .collect::<Vec<_>>();
        let delivered = RefCell::new(Some(delivered));
        measure("sync 200 new messages", DELIVERED as u64, &|| {
            let added = delivered.borrow_mut().take().unwrap_or_default();
            inner.commit(|world, tx, _| {
                let incoming = Incoming {
                    page_of: None,
                    mailboxes: None,
                    added,
                    updated: vec![],
                    removed: vec![],
                };
                reconcile(world, tx, &account_id, incoming);
            });
        });

        let updates = sent
            .borrow()
            .iter()
            .filter(|message| matches!(message, CoreMessage::Update { .. }))
            .count();
        assert!(updates > 0, "the subscriptions were answered");
        steps
    });
    let _ = std::fs::remove_dir_all(&folder);

    let over: Vec<String> = steps.iter().filter_map(Step::over_budget).collect();
    assert!(
        over.is_empty(),
        "View work grew with the mailbox ({MESSAGES} messages). A commit may only rebuild the rows of \
         the threads it touched and check only those against each list's filter. Keep each list's \
         answer in an index that the commit's touched threads update, instead of scanning every \
         thread.\n  {}",
        over.join("\n  ")
    );
}
