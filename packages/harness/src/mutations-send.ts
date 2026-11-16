// Breaks in sending: the outbox, the MIME writer and the sim provider's reading of what the
// core sent. mutations.ts runs them with the core's other breaks.

import type { Mutation } from './breaks.ts'

const core = (file: string) => `crates/core/src/${file}`

export const SEND_MUTATIONS: Mutation[] = [
  {
    name: 'a send goes out without waiting for its undo window',
    file: core('outbox.rs'),
    find: '        let window = self.env.until(until);',
    replace: '        let window = self.env.until(&self.env.now());',
    scenarios: 'undo inside the window',
  },
  {
    name: 'an undone reply stays in its conversation',
    file: core('outbox.rs'),
    find: '                remove_with_thread(world, tx, &message_id);\n',
    replace: '',
    scenarios: 'undo inside the window',
  },
  {
    name: 'a send can be undone after it went out',
    file: core('outbox.rs'),
    find: '            _ => false,\n        };\n        // Mail cannot be unsent',
    replace: '            _ => true,\n        };\n        // Mail cannot be unsent',
    scenarios: 'undo after the window',
  },
  {
    name: 'a send waits for the next sync instead of going out when its window ends',
    file: core('outbox.rs'),
    find: '        self.background(&account_id, Rc::clone(self).pass(account_id.clone(), false));\n',
    replace: '        drop(account_id);\n',
    scenarios: 'a reply shows at once',
  },
  {
    name: 'a delivered reply stays an outbox message until a sync, so a change to its conversation misses it',
    file: core('outbox.rs'),
    find: '            if let Some(message) = message {',
    replace: '            if let Some(message) = message.filter(|_| false) {',
    scenarios: 'a reply shows at once',
  },
  {
    name: 'a full resync drops a reply the provider refused',
    file: core('reconcile.rs'),
    find: '        .filter(|record| record.provider_ref().is_some())\n        .filter(|record| &record.account_id == account_id && record.round != round)',
    replace: '        .filter(|record| &record.account_id == account_id && record.round != round)',
    scenarios: 'marked failed',
  },
  {
    name: 'a restart forgets a send still in its undo window',
    file: core('outbox.rs'),
    find: '        for (change, until) in held {\n            self.hold(change, &until);\n        }\n',
    replace: '        drop(held);\n',
    scenarios: 'restart inside the undo window',
  },
  {
    name: 'a send cut off by a crash is sent again instead of looked up, so the provider gets it twice',
    file: core('outbox.rs'),
    find: '            Stage::Sending => self.unconfirmed(account_id, linked, record, outbound).await,',
    replace: '            Stage::Sending => self.post(account_id, linked, record, outbound).await,',
    scenarios: 'cut off by a crash',
  },
  {
    name: 'the core does not save that a send started, so after a crash it sends again blind',
    file: core('outbox.rs'),
    find: '        let record = self.restage(record, &outbound, Stage::Sending);\n',
    replace: '',
    scenarios: 'cut off by a crash',
  },
  {
    name: 'an empty lookup sends the message again while the first send may still land',
    file: core('outbox.rs'),
    find: '            None => self.look_again(account_id, until),',
    replace: '            None => return Box::pin(self.post(account_id, linked, record, outbound)).await,',
    scenarios: 'cut off by a crash',
  },
  {
    name: 'a send that never shows up stays unconfirmed for good',
    file: core('outbox.rs'),
    find: '            None if parse(&self.env.now()) >= parse(until) => {',
    replace: '            None if false => {',
    scenarios: 'never found fails',
  },
  {
    name: 'a copy that shows up after a send failed as unconfirmed sits beside it',
    file: core('reconcile.rs'),
    find: '        if let Some(sent) = outbox_copy(world, account_id, &remote.facts) {',
    replace: '        if let Some(sent) = outbox_copy(world, account_id, &remote.facts).filter(|_| false) {',
    scenarios: 'never found fails',
  },
  {
    name: 'undo trusts the timer, not the clock, so it unsends mail past its deadline',
    file: core('outbox.rs'),
    find: '            (Stage::Held { until }, None) => parse(&self.env.now()) < parse(until),',
    replace: '            (Stage::Held { .. }, None) => true,',
    scenarios: 'undo after',
  },
  {
    name: 'a subject word too long to fold is written whole, past the line limit',
    file: core('mime.rs'),
    find: ' && !value.contains("=?") && fits;',
    replace: ' && !value.contains("=?") && (fits || true);',
    scenarios: 'too long to fold',
  },
  {
    name: 'bcc recipients never get the message',
    file: core('outbox.rs'),
    find: '            bcc: outbound.bcc.clone(),',
    replace: '            bcc: Vec::new(),',
    scenarios: 'a new message starts',
  },
  {
    name: 'the same send sent twice reaches the provider twice',
    file: core('dispatch.rs'),
    find: '        if let Some(earlier) = earlier {',
    replace: '        if let Some(earlier) = earlier.filter(|_| false) {',
    scenarios: 'same send twice',
  },
  {
    name: 'the sim provider reads encoded subjects as they travel, so its copy differs from the one sent',
    file: 'packages/sim-provider/src/sent.ts',
    find: "      subject: decodeWords(headers.get('subject') ?? ''),",
    replace: "      subject: headers.get('subject') ?? '',",
    scenarios: 'a new message starts',
  },
]
