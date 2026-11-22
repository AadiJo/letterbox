//! The people a recipients view suggests (`Query::Recipients`), kept between commits like the
//! rows (see rows.rs). Each thread adds a contact for every person in it the user wrote to or
//! heard from. `refresh` rebuilds only the threads a commit touched, and moves only their
//! contacts in and out of each person's totals, so no commit reads a person's whole history.
//! Every person also sits in a prefix index under their address and each word of every name
//! their mail gave, so a view reads only the people its prefix matches, never everyone.
//!
//! Only the local store counts. A person is:
//!   - someone the user wrote to: in To or Cc of a message from the account's address, held or sent;
//!   - someone who wrote to the user: the sender of a message not from the account, unless the
//!     message is automated (`is_automated`) or sits in spam.
//!
//! So a newsletter is never suggested, and a person who also posts to a mailing list still is,
//! from their own mail. A no-reply address is never suggested, even one the user wrote to, and
//! neither is the account's own address.
//!
//! Ranking. People the user wrote to come first. Then the weight of their mail: each message
//! counts 2^n, where n is the number of whole 30-day periods from a fixed time to when it was
//! sent, so a message 30 days older counts half as much. Weights are exact sums of powers of
//! two (`Weight`), so they add and take away with no rounding, and the order is the same
//! however the people were built. Then the newest mail, then the address.
//!
//! In the core's tests every refresh also checks the kept people against people built afresh,
//! as the rows do.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

use letterbox_protocol::{AccountId, Recipient, Role, ThreadId, Time};

use crate::adapter::RemoteAddress;
use crate::clock::parse;
use crate::maps::{HashMap, IndexMap};
use crate::rows::Refresh;
use crate::turns::{is_automated, is_machine_address};
use crate::views::same;
use crate::work::Meter;
use crate::world::{MessageRecord, World, messages_of, scoped};

/// A message this much older than another counts half as much.
const PERIOD_SECONDS: i64 = 30 * 86_400;

/// A sum of powers of two: how many messages fall in each 30-day period, by period.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Weight(BTreeMap<i64, u64>);

impl Weight {
    /// The period a message sent at `at` falls in.
    fn period(at: &Time) -> i64 {
        parse(at).timestamp().div_euclid(PERIOD_SECONDS)
    }

    fn add(&mut self, other: &Weight) {
        for (period, count) in &other.0 {
            *self.0.entry(*period).or_default() += count;
        }
    }

    fn take(&mut self, other: &Weight) {
        for (period, count) in &other.0 {
            if let Some(held) = self.0.get_mut(period) {
                *held -= count;
                if *held == 0 {
                    self.0.remove(period);
                }
            }
        }
    }

    /// The sum written in binary, as the periods whose bit is set, highest first. Two weights
    /// compare as these do.
    fn bits(&self) -> Vec<i64> {
        let mut bits = Vec::new();
        let (mut carry, mut at) = (0u64, self.0.keys().next().copied().unwrap_or_default());
        let mut counts = self.0.iter().peekable();
        while carry > 0 || counts.peek().is_some() {
            if let Some((_, count)) = counts.next_if(|(period, _)| **period == at) {
                carry += count;
            }
            if carry & 1 == 1 {
                bits.push(at);
            }
            carry >>= 1;
            at += 1;
            if carry == 0
                && let Some((next, _)) = counts.peek()
            {
                at = **next;
            }
        }
        bits.reverse();
        bits
    }
}

/// What one thread says about one person.
#[derive(Clone, Debug, PartialEq)]
struct Contact {
    /// As the thread's newest message with them wrote it, and when that was sent.
    address: String,
    last_at: Time,
    /// The newest display name their mail in this thread gave, and when.
    name: Option<(Time, String)>,
    /// Messages from the user to them.
    wrote_to: u64,
    weight: Weight,
}

/// One person's totals across every thread, by their key: the account and the address without case.
#[derive(Clone, Debug, Default, PartialEq)]
struct Person {
    /// The address each thread last wrote, by when and which thread.
    seen: BTreeMap<(Time, ThreadId), String>,
    /// The display name each thread last gave, by when and which thread.
    named: BTreeMap<(Time, ThreadId), String>,
    /// Every name, and how many threads give it, so a name leaves the index only once none does.
    names: BTreeMap<String, u64>,
    wrote_to: u64,
    weight: Weight,
}

#[derive(Default)]
pub struct People {
    /// What each thread adds, by person key.
    contacts: HashMap<ThreadId, IndexMap<String, Contact>>,
    people: HashMap<String, Person>,
    /// (token, person key) for the address and every word of every name, without case.
    tokens: BTreeSet<(String, String)>,
    /// People whose contacts the last refresh changed.
    changed: BTreeSet<String>,
}

/// The words a prefix can match for a person: their address, each word of each name, and
/// each whole name, so "ana li" finds "Ana Lima".
fn tokens_of(key: &str, person: &Person) -> BTreeSet<String> {
    let address = key.split_once('\n').map_or(key, |(_, address)| address);
    let mut tokens = BTreeSet::from([address.to_owned()]);
    for name in person.names.keys() {
        let name = name.to_lowercase();
        let words = name
            .split_whitespace()
            .map(|word| word.trim_matches(|c: char| !c.is_alphanumeric()));
        tokens.extend(words.filter(|word| !word.is_empty()).map(str::to_owned));
        tokens.insert(name.split_whitespace().collect::<Vec<_>>().join(" "));
    }
    tokens
}

/// True when the message sits in a spam mailbox at the provider.
fn in_spam(world: &World, record: &MessageRecord) -> bool {
    let spam = |id| {
        world
            .mailboxes
            .get(id)
            .is_some_and(|mailbox| mailbox.role == Some(Role::Spam))
    };
    record.server.mailboxes.iter().any(spam)
}

/// Every contact one thread adds, in the order its messages first name them.
fn contacts_of(world: &World, thread_id: &ThreadId) -> IndexMap<String, Contact> {
    let mut contacts: IndexMap<String, Contact> = IndexMap::default();
    let mut add = |record: &MessageRecord, who: &RemoteAddress, mine: bool| {
        if is_machine_address(&who.address) {
            return;
        }
        let key = scoped(&record.account_id, &who.address.to_lowercase());
        let at = &record.facts.sent_at;
        let contact = contacts.entry(key).or_insert_with(|| Contact {
            address: who.address.clone(),
            last_at: at.clone(),
            name: None,
            wrote_to: 0,
            weight: Weight::default(),
        });
        // A thread's messages come oldest first, so the last one seen is the newest.
        contact.address.clone_from(&who.address);
        contact.last_at.clone_from(at);
        if let Some(name) = who
            .name
            .as_ref()
            .map(|name| name.trim())
            .filter(|name| !name.is_empty())
        {
            contact.name = Some((at.clone(), name.to_owned()));
        }
        contact.wrote_to += u64::from(mine);
        *contact.weight.0.entry(Weight::period(at)).or_default() += 1;
    };
    for record in messages_of(world, thread_id) {
        let Some(account) = world.accounts.get(&record.account_id) else {
            continue;
        };
        let me = |who: &RemoteAddress| same(&who.address, &account.address);
        if me(&record.facts.from) {
            // An address in both To and Cc is still one message to them.
            let mut named = BTreeSet::new();
            let everyone = record.facts.to.iter().chain(&record.facts.cc).filter(|who| !me(who));
            for who in everyone.filter(|who| named.insert(who.address.to_lowercase())) {
                add(record, who, true);
            }
        } else if !is_automated(&record.facts) && !in_spam(world, record) {
            add(record, &record.facts.from, false);
        }
    }
    contacts
}

impl Person {
    /// Adds one thread's contact to the totals, or takes it away.
    fn count(&mut self, thread_id: &ThreadId, contact: &Contact, adding: bool) {
        let seen = (contact.last_at.clone(), thread_id.clone());
        let named = contact
            .name
            .as_ref()
            .map(|(at, name)| ((at.clone(), thread_id.clone()), name));
        if adding {
            self.seen.insert(seen, contact.address.clone());
            if let Some((at, name)) = named {
                self.named.insert(at, name.clone());
                *self.names.entry(name.clone()).or_default() += 1;
            }
            self.wrote_to += contact.wrote_to;
            self.weight.add(&contact.weight);
            return;
        }
        self.seen.remove(&seen);
        if let Some((at, name)) = named {
            self.named.remove(&at);
            if let Some(count) = self.names.get_mut(name) {
                *count -= 1;
                if *count == 0 {
                    self.names.remove(name);
                }
            }
        }
        self.wrote_to -= contact.wrote_to;
        self.weight.take(&contact.weight);
    }
}

impl People {
    /// Brings the people up to date with what the rows just rebuilt. Call it after
    /// `Rows::refresh`, with the same refresh.
    pub fn refresh(&mut self, world: &World, refresh: &Refresh) {
        self.changed.clear();
        match refresh {
            Refresh::Everything => *self = People::build(world),
            Refresh::Threads { touched, .. } => {
                for id in touched {
                    self.rebuild(world, id);
                }
            }
        }
        if cfg!(test) {
            self.check(world);
        }
    }

    /// Every person, built from the world as it is now.
    fn build(world: &World) -> People {
        let mut people = People::default();
        let ids: BTreeSet<&ThreadId> = world.messages_by_thread.keys().collect();
        for id in ids {
            people.rebuild(world, id);
        }
        people.changed.clear();
        people
    }

    /// Takes one thread's old contacts out of the totals and puts its new ones in.
    fn rebuild(&mut self, world: &World, thread_id: &ThreadId) {
        let after = contacts_of(world, thread_id);
        let before = self.contacts.remove(thread_id).unwrap_or_default();
        if before != after {
            for (key, contact) in &before {
                self.change(key, |person| person.count(thread_id, contact, false));
            }
            for (key, contact) in &after {
                self.change(key, |person| person.count(thread_id, contact, true));
            }
        }
        if !after.is_empty() {
            self.contacts.insert(thread_id.clone(), after);
        }
    }

    /// Changes one person and keeps the prefix index in step with their names.
    fn change(&mut self, key: &str, edit: impl FnOnce(&mut Person)) {
        let person = self.people.entry(key.to_owned()).or_default();
        let before = tokens_of(key, person);
        edit(person);
        let (stale, kept) = if person.seen.is_empty() {
            self.people.remove(key);
            (before, BTreeSet::new())
        } else {
            let after = tokens_of(key, person);
            (&before - &after, after)
        };
        for token in stale {
            self.tokens.remove(&(token, key.to_owned()));
        }
        for token in kept {
            self.tokens.insert((token, key.to_owned()));
        }
        self.changed.insert(key.to_owned());
    }

    /// True when the last refresh changed someone a recipients view on `account_id` for
    /// `prefix` shows now (`shown`, their keys) or would show.
    pub fn touches(&self, account_id: &AccountId, prefix: &str, shown: &[String]) -> bool {
        let prefix = normalize(prefix);
        let account = scoped(account_id, "");
        self.changed.iter().any(|key| {
            let matches = || {
                let person = self.people.get(key);
                person.is_some_and(|person| tokens_of(key, person).iter().any(|token| token.starts_with(&prefix)))
            };
            shown.contains(key) || (!prefix.is_empty() && key.starts_with(&account) && matches())
        })
    }

    /// The best `limit` people on `account_id` that `prefix` matches, ranked as the module
    /// says, each with their key. Reads only the people the prefix matches.
    pub fn suggest(&self, account_id: &AccountId, prefix: &str, limit: u64, meter: &Meter) -> Vec<(String, Recipient)> {
        let prefix = normalize(prefix);
        if prefix.is_empty() {
            return Vec::new();
        }
        let account = scoped(account_id, "");
        let keys: BTreeSet<&String> = self
            .tokens
            .range((prefix.clone(), String::new())..)
            .take_while(|(token, _)| token.starts_with(&prefix))
            .map(|(_, key)| key)
            .filter(|key| key.starts_with(&account))
            .collect();
        let mut ranked: Vec<(&String, &Person, Vec<i64>)> = keys
            .into_iter()
            .filter_map(|key| {
                meter.ranked();
                let person = self.people.get(key)?;
                Some((key, person, person.weight.bits()))
            })
            .collect();
        ranked.sort_by(|(a_key, a, a_bits), (b_key, b, b_bits)| {
            let newest = |person: &Person| person.seen.keys().next_back().map(|(at, _)| at.clone());
            (b.wrote_to > 0)
                .cmp(&(a.wrote_to > 0))
                .then_with(|| compare_bits(b_bits, a_bits))
                .then_with(|| newest(b).cmp(&newest(a)))
                .then_with(|| a_key.cmp(b_key))
        });
        let limit = usize::try_from(limit).unwrap_or(usize::MAX);
        let recipients = ranked.into_iter().take(limit).map(|(key, person, _)| {
            let newest = person.seen.iter().next_back();
            let recipient = Recipient {
                name: person.named.values().next_back().cloned(),
                address: newest.map(|(_, address)| address.clone()).unwrap_or_default(),
                last_at: newest.map(|((at, _), _)| at.clone()).unwrap_or_default(),
            };
            (key.clone(), recipient)
        });
        recipients.collect()
    }

    /// Panics when the kept people differ from people built afresh.
    fn check(&self, world: &World) {
        let fresh = People::build(world);
        assert!(
            self.contacts == fresh.contacts && self.people == fresh.people && self.tokens == fresh.tokens,
            "the people kept between commits differ from people built afresh, so a change to the \
             world did not mark every thread it affects (see `Touched` in world.rs)"
        );
    }
}

/// Compares two weights written as `Weight::bits` gives them.
fn compare_bits(a: &[i64], b: &[i64]) -> Ordering {
    for (a, b) in a.iter().zip(b) {
        match a.cmp(b) {
            Ordering::Equal => {}
            other => return other,
        }
    }
    a.len().cmp(&b.len())
}

/// A typed prefix as the index compares it.
fn normalize(prefix: &str) -> String {
    prefix.trim_start().to_lowercase()
}
