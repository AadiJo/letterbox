//! The budget for view work per commit: a commit may rebuild and re-check only the threads
//! it touched, so its cost follows what it changed, not the size of the mailbox.
//!
//! The test fills a large mailbox, keeps open what the app keeps open (the accounts, the
//! mailboxes, the inbox's first page, Your turn and Let go?, which filter by turn and split
//! on age, Updates, which groups automated mail by sender, one conversation, and a recipient
//! field's suggestions for a typed prefix, and where a send is), then counts the work (see work.rs) of each step a
//! person causes. It counts instead of timing, so it gives the same answer on every machine.
//! The body pipeline counts too: a step may process at most one body per thread it touched,
//! since only a conversation someone has open has its bodies processed (body/mod.rs). Each
//! body it processes may rebuild its thread's row once more, as what the pipeline finds (an
//! unsubscribe link) can change the row.
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
use crate::world::{AccountRecord, ChangeOutcome, Health, MessageRecord, put_account, put_change, put_message};
use crate::{Core, CoreOptions};

/// Large enough that a view which reads every thread costs thousands of rows per commit.
const MESSAGES: usize = 20_000;
/// The thread lists and Updates the test keeps open. Each may check a touched thread against its filter.
const LISTS: u64 = 4;
const DELIVERED: usize = 200;
/// What the recipient field has typed. It matches person1, person10 to person19 and person100
/// to person199: the mailbox's 300 correspondents never grow with it.
const PREFIX: &str = "person1";
/// How many people `PREFIX` matches. A commit may rank at most these, once.
const MATCHED: u64 = 111;
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
                list_unsubscribe_value: String::new(),
                list_unsubscribe_post: String::new(),
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
        web: Box::new(crate::web::NoWeb),
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
            summarized: self.touched + self.work.processed,
            matched: self.touched * LISTS,
            ranked: MATCHED,
            processed: self.touched,
        };
        let over = self.work.summarized > allowed.summarized
            || self.work.matched > allowed.matched
            || self.work.ranked > allowed.ranked
            || self.work.processed > allowed.processed;
        over.then(|| {
            format!(
                "{}: touched {} thread(s), summarized {} (budget {}), matched {} against list filters (budget {}), \
                 ranked {} people (budget {}) and processed {} bodies (budget {})",
                self.name,
                self.touched,
                self.work.summarized,
                allowed.summarized,
                self.work.matched,
                allowed.matched,
                self.work.ranked,
                allowed.ranked,
                self.work.processed,
                allowed.processed
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
        inner.commit(|world, tx, at| {
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
            let arrived = reconcile(world, tx, &account_id, incoming, at);
            assert!(arrived.0.is_empty(), "the test mailbox has no sends");
        });

        let inbox = {
            let state = inner.state.borrow();
            let inbox = state
                .world
                .mailboxes
                .values()
                .find(|record| record.role == Some(Role::Inbox));
            inbox
                .map(|record| record.id.clone())
                .expect("the test mailbox has an inbox")
        };
        let receive = |message: Value| core.receive(message);
        receive(json!({ "kind": "hello", "protocol": letterbox_protocol::PROTOCOL }));
        let views = [
            json!({ "view": "accounts" }),
            json!({ "view": "mailboxes" }),
            json!({ "view": "threads", "filter": {}, "offset": 0, "limit": 50 }),
            json!({ "view": "threads", "filter": { "turn": "mine", "retired": false }, "offset": 0, "limit": 50 }),
            json!({ "view": "threads", "filter": { "turn": "mine", "retired": true }, "offset": 0, "limit": 50 }),
            json!({ "view": "senders", "mailboxId": inbox, "zone": "America/Chicago", "offset": 0, "limit": 50 }),
            json!({ "view": "recipients", "accountId": account_id, "prefix": PREFIX, "limit": 8 }),
            json!({ "view": "change", "change": "change-unknown" }),
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
            // As a pass settles it: what the provider now holds, and the outcome, in one commit.
            inner.commit(|world, tx, at| {
                for op in change.effect.ops() {
                    for id in op.message_ids() {
                        let Some(record) = world.messages.get(id).cloned() else {
                            continue;
                        };
                        let server = crate::changes::overlay(&record.server, op, id);
                        put_message(world, tx, MessageRecord { server, ..record });
                    }
                }
                let outcome = Some(ChangeOutcome {
                    rev: at,
                    result: ChangeResult::Done,
                });
                put_change(world, tx, crate::world::ChangeRecord { outcome, ..change });
            });
        });
        measure("undo the settled command", 1, &|| {
            receive(json!({
                "kind": "command",
                "change": "change_undo",
                "command": { "kind": "undo", "change": "change_1" },
            }));
        });
        let reversed = inner
            .state
            .borrow()
            .world
            .changes
            .get(&ChangeId::new("change_undo"))
            .is_some_and(|change| change.outcome.is_none());
        assert!(
            reversed,
            "the undo was accepted as a reversal, so its step measured a real undo"
        );
        let answered = inner
            .state
            .borrow()
            .world
            .messages_by_thread
            .get(&newest)
            .and_then(|ids| ids.first().cloned());
        // The open conversation's subject, so the reply joins it and its body is processed there.
        let subject = format!("Re: Topic {}", conversations - 1);
        measure("send a reply", 1, &|| {
            receive(json!({
                "kind": "command",
                "change": "change_2",
                "command": { "kind": "send", "draft": {
                    "accountId": account_id, "to": ["person1@example.com"], "cc": [], "bcc": [],
                    "subject": subject, "text": "Yes.", "html": null, "inReplyTo": answered,
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
            inner.commit(|world, tx, at| {
                let incoming = Incoming {
                    page_of: None,
                    mailboxes: None,
                    added,
                    updated: vec![],
                    removed: vec![],
                };
                let arrived = reconcile(world, tx, &account_id, incoming, at);
                assert!(arrived.0.is_empty(), "the test mailbox has no sends");
            });
        });

        let updates = sent
            .borrow()
            .iter()
            .filter(|message| matches!(message, CoreMessage::Update { .. }))
            .count();
        assert!(updates > 0, "the subscriptions were answered");
        let suggested = sent.borrow().iter().any(|message| {
            matches!(message, CoreMessage::Update { update: letterbox_protocol::Update::Recipients { data }, .. } if data.len() == 8)
        });
        assert!(suggested, "the recipients view suggested people, so its steps measured real ranking");
        steps
    });
    let _ = std::fs::remove_dir_all(&folder);

    let reply = steps.iter().find(|step| step.name == "send a reply");
    assert_eq!(
        reply.map(|step| step.work.processed),
        Some(1),
        "the reply joined the open conversation and its body was processed, so the budget measured real processing"
    );
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
