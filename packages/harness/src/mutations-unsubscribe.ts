// Breaks in unsubscribing from a sender (crates/core/src/unsubscribe): the hold and its undo,
// the DKIM check RFC 8058 asks for, the POST and how its answer is read, the mailto and web
// fallbacks, a restart, and what Updates shows. mutations.ts runs them with the others.

import type { Mutation } from './breaks.ts'

const unsubscribe = (file: string) => `crates/core/src/unsubscribe/${file}`

const HELD = 'an unsubscribe held for its window is undone'
const POSTED = 'a one-click unsubscribe whose DKIM signature verifies is posted once'
const FALLBACK = 'a one-click unsubscribe whose DKIM check fails goes out once as mail'
const REFUSED = 'a one-click unsubscribe at a private address is refused'
const WEB = 'a web unsubscribe opens its page'
const RESTART = 'an unsubscribe held across a restart'
const CUT_OFF = "an unsubscribe's POST cut off by a stopped core"

export const UNSUBSCRIBE_MUTATIONS: Mutation[] = [
  {
    name: 'an unsubscribe goes out at once, with no window to undo it in',
    file: unsubscribe('mod.rs'),
    find: '        self.hold_unsubscribe(change, &until);',
    replace: '        drop(until);\n        self.release_unsubscribe(change);',
    scenarios: HELD,
  },
  {
    name: 'Updates shows nothing while an unsubscribe is held',
    file: unsubscribe('mod.rs'),
    find: '        (None, Some(until)) => Some(Unsubscribed::Held { change, until, method }),',
    replace: '        (None, Some(_)) => None,',
    scenarios: HELD,
  },
  {
    name: 'an undo after an unsubscribe went out is accepted, though the sender has it',
    file: 'crates/core/src/undo.rs',
    find: '            Ok(Answer::Unsubscribe) => self.undo_unsubscribe(change, record),',
    replace: '            Ok(Answer::Unsubscribe) => self.cancel(change, record, |_, _| {}),',
    scenarios: POSTED,
  },
  {
    name: 'an open Updates does not hear that an unsubscribe moved on',
    file: 'crates/core/src/senders.rs',
    find: '        let mut moved = today != self.today || unsubscribes;',
    replace: '        let mut moved = today != self.today && unsubscribes;',
    scenarios: POSTED,
  },
  {
    name: 'a one-click is posted without a DKIM signature that verifies',
    file: unsubscribe('dkim.rs'),
    find: '    outputs.iter().any(passed).then_some(url)',
    replace: '    drop(outputs.iter().any(passed));\n    Some(url)',
    scenarios: FALLBACK,
  },
  {
    name: 'a signature that does not cover List-Unsubscribe-Post is enough for a one-click',
    file: unsubscribe('dkim.rs'),
    find: '    names("List-Unsubscribe") && names("List-Unsubscribe-Post")',
    replace: '    names("List-Unsubscribe")',
    scenarios: FALLBACK,
  },
  {
    name: 'a one-click that fails its check opens the page instead of sending the mailto',
    file: unsubscribe('mod.rs'),
    find: '                Some(Unsubscribe::Mailto { uri, .. }) => Some(uri),',
    replace: '                Some(Unsubscribe::Mailto { .. }) => None,',
    scenarios: FALLBACK,
  },
  {
    name: "a mailto's + reads as a space, as in a web form",
    file: unsubscribe('mailto.rs'),
    find: '    percent_decode_str(text)',
    replace: '    percent_decode_str(&text.replace(\'+\', " "))',
    scenarios: FALLBACK,
  },
  {
    name: 'a redirect after a POST counts as unsubscribed',
    file: unsubscribe('mod.rs'),
    find: '            Posted::Answered { .. } | Posted::Redirect => ChangeResult::Failed(Refusal::RefusedByProvider),',
    replace:
      '            Posted::Redirect => ChangeResult::Done,\n            Posted::Answered { .. } => ChangeResult::Failed(Refusal::RefusedByProvider),',
    scenarios: REFUSED,
  },
  {
    name: 'a host at a private address reads as unreachable, so the page opens instead',
    file: 'crates/host/src/web.rs',
    find: '            Err(Stop::Refused) => return Posted::Refused,',
    replace: '            Err(Stop::Refused) => return Posted::NotSent,',
    scenarios: REFUSED,
  },
  {
    name: 'the one-click POST is sent as plain text, not as a form',
    file: 'crates/host/src/web.rs',
    find: '            .header(CONTENT_TYPE, "application/x-www-form-urlencoded")',
    replace: '            .header(CONTENT_TYPE, "text/plain")',
    scenarios: POSTED,
  },
  {
    name: 'the gmail adapter fetches the parsed message, not its raw source, so no signature can verify',
    file: 'crates/gmail/src/adapter.rs',
    find: '        let path = format!("messages/{}?format=raw", r#ref.as_str());',
    replace: '        let path = format!("messages/{}?format=full", r#ref.as_str());',
    scenarios: POSTED,
  },
  {
    name: 'a web unsubscribe never tells the shell to open its page',
    file: unsubscribe('mod.rs'),
    find: '        self.send(CoreMessage::OpenUrl(page));',
    replace: '        drop(page);',
    scenarios: WEB,
  },
  {
    name: 'a restart forgets a held unsubscribe, so it never goes out',
    file: unsubscribe('mod.rs'),
    find: '                Stage::Held { until } => self.hold_unsubscribe(record.id, &until),',
    replace: '                Stage::Held { .. } => {}',
    scenarios: RESTART,
  },
  {
    name: 'a POST a stopped core may have sent goes again after a restart',
    file: unsubscribe('mod.rs'),
    find: '            (Stage::Posting { .. }, _) => self.settle(record, ChangeResult::Failed(Refusal::Unconfirmed)),',
    replace:
      '            (Stage::Posting { url }, _) => self.post_one_click(record, unsubscription.clone(), url.clone()).await,',
    scenarios: CUT_OFF,
  },
]
