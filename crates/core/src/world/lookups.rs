//! The world's lookup tables, kept in step with its records by the put_ and remove_
//! functions in world.rs: messages by ref, thread, Message-ID and reference, and the newest
//! unsubscribe from each sender.

use letterbox_protocol::MessageId;

use super::{ChangeRecord, MessageRecord, World, scoped};
use crate::maps::{HashMap, IndexSet};
use crate::unsubscribe::sender_key;

fn add_to<K: std::hash::Hash + Eq>(index: &mut HashMap<K, IndexSet<MessageId>>, key: K, id: &MessageId) {
    index.entry(key).or_default().insert(id.clone());
}

fn drop_from<K: std::hash::Hash + Eq>(index: &mut HashMap<K, IndexSet<MessageId>>, key: &K, id: &MessageId) {
    let Some(set) = index.get_mut(key) else { return };
    set.shift_remove(id);
    if set.is_empty() {
        index.remove(key);
    }
}

pub(super) fn index(world: &mut World, record: &MessageRecord) {
    let account = &record.account_id;
    if let Some(r#ref) = record.provider_ref() {
        world
            .message_by_ref
            .0
            .insert(scoped(account, r#ref.as_str()), record.id.clone());
    }
    add_to(&mut world.messages_by_thread.0, record.thread_id.clone(), &record.id);
    if let Some(message_id) = &record.facts.message_id {
        add_to(
            &mut world.messages_by_message_id.0,
            scoped(account, message_id),
            &record.id,
        );
    }
    for reference in &record.facts.references {
        add_to(
            &mut world.messages_by_reference.0,
            scoped(account, reference),
            &record.id,
        );
    }
}

pub(super) fn unindex(world: &mut World, record: &MessageRecord) {
    let account = &record.account_id;
    if let Some(r#ref) = record.provider_ref() {
        world.message_by_ref.0.remove(&scoped(account, r#ref.as_str()));
    }
    drop_from(&mut world.messages_by_thread.0, &record.thread_id, &record.id);
    if let Some(message_id) = &record.facts.message_id {
        drop_from(
            &mut world.messages_by_message_id.0,
            &scoped(account, message_id),
            &record.id,
        );
    }
    for reference in &record.facts.references {
        drop_from(
            &mut world.messages_by_reference.0,
            &scoped(account, reference),
            &record.id,
        );
    }
}

/// Keeps `change` in `unsubscribes` when it is an unsubscribe, as the newest from its sender,
/// by the rev each was accepted at: an earlier one that moves on later keeps its place behind.
pub(super) fn note_unsubscribe(world: &mut World, change: &ChangeRecord) {
    let Some(address) = change.effect.unsubscribes() else {
        return;
    };
    let key = sender_key(&change.account_id, address);
    let kept = world.unsubscribes.get(&key).and_then(|id| world.changes.get(id));
    if kept.is_none_or(|kept| kept.accepted_rev <= change.accepted_rev) {
        world.unsubscribes.0.insert(key, change.id.clone());
    }
}

/// Drops `change`, which is gone, from `unsubscribes` when it was the newest from its sender.
pub(super) fn forget_unsubscribe(world: &mut World, change: &ChangeRecord) {
    let Some(address) = change.effect.unsubscribes() else {
        return;
    };
    world.touched.unsubscribes = true;
    let key = sender_key(&change.account_id, address);
    if world.unsubscribes.get(&key) == Some(&change.id) {
        world.unsubscribes.0.remove(&key);
    }
}
