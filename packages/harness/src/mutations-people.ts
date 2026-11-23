// Breaks in the People-first lists: Updates, which groups automated mail by sender
// (rows.rs, senders.rs), and Your turn and Let go?, which split turns of mine at 30 days on
// the core's clock (live_view.rs, subscriptions.rs). mutations.ts runs them with the core's
// other breaks.

import type { Mutation } from './breaks.ts'

const core = (file: string) => `crates/core/src/${file}`

export const PEOPLE_MUTATIONS: Mutation[] = [
  {
    name: 'Updates groups mail from people with the automated mail',
    file: core('rows.rs'),
    find: '    if !is_automated(&newest.facts) {\n        return None;\n    }\n',
    replace: '',
    scenarios: 'Updates groups',
  },
  {
    name: 'Updates tells one sender apart by the case of its address',
    file: core('rows.rs'),
    find: 'format!("sender_{account_id}_{}", from.address.to_lowercase())',
    replace: 'format!("sender_{account_id}_{}", from.address)',
    scenarios: 'Updates groups',
  },
  {
    name: 'my reply to an alert takes the conversation out of Updates',
    file: core('rows.rs'),
    find: '.find(|record| !same(&record.facts.from.address, me))?;',
    replace: '.find(|_| !me.is_empty())?;',
    scenarios: 'Updates groups',
  },
  {
    name: 'Updates counts unread conversations, not unread messages',
    file: core('rows.rs'),
    find: 'unread: states.iter().filter(|state| state.unread).count() as u64,',
    replace: 'unread: u64::from(states.iter().any(|state| state.unread)),',
    scenarios: 'Updates groups',
  },
  {
    name: 'Updates keeps counting a conversation as unread after it is read',
    file: core('senders.rs'),
    find: '        group.unread -= listed.unread;',
    replace: '        let _ = listed.unread;',
    scenarios: 'Updates groups',
  },
  {
    name: 'a sender with newer mail is listed twice in Updates',
    file: core('senders.rs'),
    find: '            self.order.remove(&(time, id.clone()));',
    replace: '            let _ = (time, id);',
    scenarios: 'Updates groups',
  },
  {
    name: 'Updates keeps conversations archived out of its mailbox',
    file: core('senders.rs'),
    find: '            matches(listed, &self.filter)\n                && self',
    replace: '            true\n                && self',
    scenarios: 'Updates groups',
  },
  {
    name: "opening a sender lists every conversation, so acting on it acts on others' mail too",
    file: core('views.rs'),
    find: '        && listed.sender.as_ref().is_none_or(|from| from.id != *sender)',
    replace: '        && false',
    scenarios: 'acting on a whole sender',
  },
  {
    name: 'Your turn keeps turns 30 days old',
    file: core('live_view.rs'),
    find: '        Some(false) => listed.range(..cut(&live.now())),',
    replace: '        Some(false) => listed.range::<Place, _>(..),',
    scenarios: 'letting turns go',
  },
  {
    name: 'no wake is booked, so a turn stays in Your turn past 30 days until something else changes',
    file: core('subscriptions.rs'),
    find: '            self.book_wake(at);',
    replace: '            let _ = at;',
    scenarios: 'crosses 30 days',
  },
  {
    name: 'the wake answers no list, so a turn crosses 30 days unseen',
    file: core('subscriptions.rs'),
    find: '            core.flush();\n        });',
    replace: '            drop(core);\n        });',
    scenarios: 'crosses 30 days',
  },
  {
    name: 'a list that splits on age answers again only on a commit, not when the clock moves its cut',
    file: core('live_view.rs'),
    find: '                moved |= now != *edge;',
    replace: '',
    scenarios: 'crosses 30 days',
  },
  {
    name: 'a wake runs on the time the lists last read, so the turn it woke for never crosses',
    file: core('subscriptions.rs'),
    find: '                state.views_now = core.env.now();',
    replace: '',
    scenarios: 'crosses 30 days',
  },
  {
    name: 'a list that splits on age opens on a time it never read, so every turn is fresh',
    file: core('subscriptions.rs'),
    find: '                *views_now = self.env.now();',
    replace: '',
    scenarios: 'letting turns go',
  },
  {
    name: "Updates keeps an archived conversation's messages in its sender's days",
    file: core('senders.rs'),
    find: '                sum.messages -= 1;\n                sum.unread -= u64::from(*unread);\n',
    replace: '                let _ = (unread, &sum);\n',
    scenarios: 'per day',
  },
  {
    name: 'Updates counts unread messages, not senders with unread mail, for the sidebar',
    file: core('senders.rs'),
    find: '        self.unread_senders = self.unread_senders - u64::from(was > 0) + u64::from(now > 0);',
    replace: '        self.unread_senders = self.unread;',
    scenarios: 'per day',
  },
  {
    name: 'no wake is booked for Updates, so its days never move on at midnight',
    file: core('live_view.rs'),
    find: '            return senders.wakes_at();',
    replace: '            return None;',
    scenarios: 'per day',
  },
  {
    name: 'Updates answers again only on a commit, so a wake at midnight leaves the days where they were',
    file: core('senders.rs'),
    find: '        let mut moved = today != self.today || unsubscribes;',
    replace: '        let mut moved = unsubscribes;',
    scenarios: 'per day',
  },
  {
    name: 'Updates reads its days off the epoch, not the clock, so every day is empty',
    file: core('subscriptions.rs'),
    find: '            if opening.any(|entry| LiveView::splits_on_age(&entry.query)) {',
    replace:
      '            if opening.any(|entry| matches!(&entry.query, Query::Threads { filter, .. } if filter.retired.is_some())) {',
    scenarios: 'per day',
  },
  {
    name: "Updates ignores the user's zone and counts UTC days",
    file: core('live_view.rs'),
    find: '                    zone_of(zone.as_deref()),',
    replace: '                    zone_of(zone.as_deref().filter(|_| false)),',
    scenarios: "user's days",
  },
  {
    name: "Updates' midnight wake comes 24 hours after the day began, so it misses a midnight a clock change moved",
    file: core('senders.rs'),
    find: '        let start = start_of(self.zone, self.today.succ_opt()?);',
    replace: '        let start = start_of(self.zone, self.today) + 86_400;',
    scenarios: "user's days",
  },
]
