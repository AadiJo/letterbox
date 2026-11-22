//! Linking and unlinking accounts. A sign-in request runs one attempt (see sign_in.rs),
//! then installs the adapter it reached, starts the first sync and the sync schedule after
//! it (schedule.rs). A sign-out unlinks
//! the adapter at once and keeps or deletes the account's mail.

use std::rc::Rc;

use letterbox_protocol::{
    AccountId, Answer, ChangeId, ChangeResult, CoreMessage, Empty, PasswordInput, Refusal, RequestId, Response,
    SignInError, SignInOptionId, SignedIn,
};

use crate::adapter::{Connection, SignInInput};
use crate::schedule::Start;
use crate::sign_in::{Outcome, outcome};
use crate::sync::Pull;
use crate::world::{
    AccountRecord, Health, put_account, remove_account, remove_change, remove_mailbox, remove_message, remove_thread,
};
use crate::{Inner, Linked};

impl Inner {
    pub(crate) fn sign_in(self: &Rc<Self>, id: RequestId, option: SignInOptionId, password: Option<PasswordInput>) {
        let Some(factory) = self.factories.get(option.as_str()).cloned() else {
            return self.respond(id, Response::SignIn(Answer::from(Err(SignInError::Denied))));
        };
        let (attempt, prior) = self.state.borrow_mut().attempts.start(&option);
        let core = Rc::clone(self);
        self.work.spawn_local(async move {
            if let Some(prior) = prior {
                prior.answered.cancelled().await;
            }
            let newest = || core.state.borrow().attempts.is_newest(&option, &attempt);
            let ended = if newest() {
                let open_url = {
                    let core = Rc::clone(&core);
                    let id = id.clone();
                    Box::new(move |url| core.send(CoreMessage::OpenUrl { id: id.clone(), url }))
                };
                let input = SignInInput {
                    password,
                    open_url,
                    signal: attempt.signal.clone(),
                };
                let answer = factory.connect(input).await;
                outcome(newest(), answer)
            } else {
                Outcome::Superseded(None)
            };
            core.end_sign_in(id, &factory.option().id, ended);
            core.state.borrow_mut().attempts.answered(&option, &attempt);
        });
    }

    /// Answers a sign-in attempt from how it ended. Each arm answers once, and none of them
    /// awaits, so no other sign-in or sign-out can land between the decision and the answer.
    fn end_sign_in(self: &Rc<Self>, id: RequestId, factory_id: &str, ended: Outcome) {
        match ended {
            Outcome::Superseded(unused) => {
                self.respond(id, Response::SignIn(Answer::from(Err(SignInError::Superseded))));
                if let Some(connection) = unused {
                    self.work.spawn_local(async move { connection.adapter.close().await });
                }
            }
            Outcome::Failed(failure) => self.respond(id, Response::SignIn(Answer::from(Err(failure.into())))),
            Outcome::SignedIn(connection) => self.install(id, factory_id, connection),
        }
    }

    /// Links the account a sign-in reached, or relinks it if this address signed in before,
    /// answers the sign-in and starts its first sync, and the schedule that pulls a period after
    /// that sync and any backfill it starts end. The link it replaces stops: its adapter closes
    /// after, and its schedule ends.
    ///
    /// The session goes to the secret store before the commit that marks the account signed
    /// in, so the store never names a signed-in account without a session to resume. A crash
    /// between the two leaves a new account's session under an id the store does not have,
    /// which nothing resumes and a later sign-in given that id overwrites, or an account that
    /// signed in before with its newer session in place of the old one. If the secret store
    /// refuses the session, the sign-in fails with `keychain` and nothing is linked: an
    /// account that would be signed out at the next start is worse than asking again now.
    fn install(self: &Rc<Self>, id: RequestId, factory_id: &str, connection: Connection) {
        let address = connection.address.to_lowercase();
        let existing = self
            .state
            .borrow()
            .world
            .accounts
            .values()
            .find(|account| account.factory_id == factory_id && account.address.to_lowercase() == address)
            .cloned();
        let account_id = existing
            .as_ref()
            .map_or_else(|| self.store.next_id(), |account| account.id.clone());
        if self.secrets.write(&account_id, &connection.session).is_err() {
            self.respond(id, Response::SignIn(Answer::from(Err(SignInError::Keychain))));
            self.work.spawn_local(async move { connection.adapter.close().await });
            return;
        }
        let capabilities = connection.adapter.capabilities();
        let (linked, replaced) = {
            let mut state = self.state.borrow_mut();
            state.links += 1;
            let linked = Linked::new(connection.adapter, state.links, &self.closing);
            let replaced = state.adapters.insert(account_id.clone(), linked.clone());
            (linked, replaced)
        };
        self.commit(|world, tx, _| {
            put_account(
                world,
                tx,
                AccountRecord {
                    id: account_id.clone(),
                    address: connection.address,
                    provider_label: connection.provider_label,
                    factory_id: factory_id.to_owned(),
                    signed_in: true,
                    capabilities,
                    cursor: existing.as_ref().and_then(|account| account.cursor.clone()),
                    // A snapshot that was under way resumes from its saved page.
                    round: existing.as_ref().map_or(0, |account| account.round),
                    snapshot: existing.as_ref().and_then(|account| account.snapshot.clone()),
                    images_from: existing
                        .as_ref()
                        .map_or_else(Vec::new, |account| account.images_from.clone()),
                    last_synced_at: existing.and_then(|account| account.last_synced_at),
                    health: Health::Ok,
                },
            );
        });
        let signed_in = SignedIn {
            account_id: account_id.clone(),
        };
        self.respond(id, Response::SignIn(Answer::from(Ok(signed_in))));
        let first = self.enqueue_pull(&account_id, Rc::clone(self).sync_pass(account_id.clone(), Pull::Shown));
        self.schedule(account_id, linked, Start::After(first));
        if let Some(replaced) = replaced {
            replaced.stop.cancel();
            self.work.spawn_local(async move { replaced.adapter.close().await });
        }
    }

    /// Signs the account out at once. No await stands between taking the adapter and
    /// changing the records, so no sign-in can land in between. The link stops: the adapter
    /// closes after, and its sync schedule ends.
    /// A pass still running for the account sees its adapter is gone and writes nothing
    /// more (see `still_current`). Deleting the mail settles the account's waiting changes
    /// as failed, since each accepted change gets exactly one `settled` (guarantee 2).
    ///
    /// The commit comes first and the session is deleted after it, so a crash between the
    /// two leaves a session the store no longer counts as signed in, and nothing resumes it.
    /// A failed delete leaves the same state, so the sign-out still succeeds. The session
    /// stays in the secret store unread until a sign-in to the same account id overwrites it.
    pub(crate) fn sign_out(self: &Rc<Self>, id: RequestId, account_id: AccountId, delete_local_mail: bool) {
        let unlinked = self.state.borrow_mut().adapters.remove(&account_id);
        let waiting: Vec<ChangeId> = if delete_local_mail {
            let state = self.state.borrow();
            let changes = state.world.changes.values();
            changes
                .filter(|change| change.account_id == account_id && change.outcome.is_none())
                .map(|change| change.id.clone())
                .collect()
        } else {
            Vec::new()
        };
        let rev = self.commit(|world, tx, _| {
            let Some(account) = world.accounts.get(&account_id).cloned() else {
                return;
            };
            if !delete_local_mail {
                let health = Health::NeedsSignIn;
                return put_account(
                    world,
                    tx,
                    AccountRecord {
                        signed_in: false,
                        health,
                        ..account
                    },
                );
            }
            let messages: Vec<_> = world
                .messages
                .values()
                .filter(|record| record.account_id == account_id)
                .map(|record| record.id.clone())
                .collect();
            for id in &messages {
                remove_message(world, tx, id);
            }
            let threads: Vec<_> = world
                .threads
                .values()
                .filter(|record| record.account_id == account_id)
                .map(|record| record.id.clone())
                .collect();
            for id in &threads {
                remove_thread(world, tx, id);
            }
            let mailboxes: Vec<_> = world
                .mailboxes
                .values()
                .filter(|record| record.account_id == account_id)
                .map(|record| record.id.clone())
                .collect();
            for id in &mailboxes {
                remove_mailbox(world, tx, id);
            }
            let changes: Vec<_> = world
                .changes
                .values()
                .filter(|record| record.account_id == account_id)
                .map(|record| record.id.clone())
                .collect();
            for id in &changes {
                remove_change(world, tx, id);
            }
            remove_account(world, tx, &account_id);
        });
        let _ = self.secrets.delete(&account_id);
        let result = ChangeResult::Failed(Refusal::UnknownTarget);
        for change in waiting {
            self.send(CoreMessage::Settled { change, rev, result });
        }
        self.respond(id, Response::SignOut(Answer::from(Ok(Empty {}))));
        if let Some(unlinked) = unlinked {
            unlinked.stop.cancel();
            self.work.spawn_local(async move { unlinked.adapter.close().await });
        }
    }
}
