// Breaks in unsubscribing from a sender (crates/core/src/unsubscribe): the hold and its undo,
// the DKIM check RFC 8058 asks for, the POST and how its answer is read, the mailto and web
// fallbacks, a restart, and what Updates shows. mutations.ts runs them with the others.

import type { Mutation } from './breaks.ts'

const unsubscribe = (file: string) => `crates/core/src/unsubscribe/${file}`

const HELD = 'an unsubscribe held for its window is undone'
const POSTED = 'a one-click unsubscribe whose DKIM signature verifies is posted once'
const FALLBACK = 'a one-click unsubscribe whose DKIM check fails goes out once as mail'
const REFUSED = 'a one-click unsubscribe at a private address is refused'
const WEB = 'a web unsubscribe keeps its page'
const RESTART = 'an unsubscribe held across a restart'
const CUT_OFF = "an unsubscribe's POST cut off by a stopped core"
const NOT_VOUCHED = 'a one-click unsubscribe without an aligned signature'
const SECOND_CORE = 'a second core on the same store is refused'
const REGISTRABLE = "an unsubscribe's one-click signature aligns only within"
const ONE_SENDER = 'a senders view of one address holds that sender alone'
const ONCE = 'a sender already unsubscribed from, done or left at its page, is refused another'

export const UNSUBSCRIBE_MUTATIONS: Mutation[] = [
  {
    name: 'a sender already unsubscribed from may be asked again, and sent again',
    file: unsubscribe('mod.rs'),
    find: 'Some(Unsubscribed::Done { .. } | Unsubscribed::Page { .. }) => return Err(Refusal::AlreadyUnsubscribed),',
    replace: 'Some(Unsubscribed::Done { .. } | Unsubscribed::Page { .. }) => {}',
    scenarios: ONCE,
  },
  {
    name: 'a senders view of one address holds every sender',
    file: 'crates/core/src/senders.rs',
    find: '.is_none_or(|address| sender.address.to_lowercase() == *address)',
    replace: '.is_none_or(|_| true)',
    scenarios: ONE_SENDER,
  },
  {
    name: 'a senders view of one address compares it with case, so a From written otherwise has no row',
    file: 'crates/core/src/live_view.rs',
    find: 'address.as_deref().map(str::to_lowercase),',
    replace: 'address.clone(),',
    scenarios: ONE_SENDER,
  },
  {
    name: 'an unsubscribe goes out at once, with no window to undo it in',
    file: unsubscribe('mod.rs'),
    find: '        self.hold_unsubscribe(change, &until);',
    replace: '        drop(until);\n        self.release_unsubscribe(change);',
    scenarios: HELD,
  },
  {
    name: 'Updates shows a held unsubscribe as already on its way',
    file: unsubscribe('mod.rs'),
    find: '        (None, Some(Stage::Held { until })) => Some(Unsubscribed::Held {',
    replace: '        (None, Some(Stage::Held { until })) if until.is_empty() => Some(Unsubscribed::Held {',
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
    find: '    names("From") && names("List-Unsubscribe") && names("List-Unsubscribe-Post")',
    replace: '    names("From") && names("List-Unsubscribe")',
    scenarios: FALLBACK,
  },
  {
    name: 'a one-click that fails its check opens the page instead of sending the mailto',
    file: unsubscribe('mod.rs'),
    find: '                Some(Unsubscribe::Mailto { uri, .. }) => Some(uri),',
    replace: '                Some(Unsubscribe::Mailto { .. }) => None::<String>,',
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
    name: 'a web unsubscribe that only kept its page shows as done',
    file: unsubscribe('mod.rs'),
    find: '        (Some(ChangeResult::Done), Some(Stage::Page { url })) => Some(Unsubscribed::Page {',
    replace:
      '        (Some(ChangeResult::Done), Some(Stage::Page { url })) if url.is_empty() => Some(Unsubscribed::Page {',
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
  {
    name: 'a second core opens a store another core has open, so both act on its changes',
    file: 'crates/core/src/store.rs',
    find: '        Err(StoreError::Locked)\n    }',
    replace: '        Ok(FolderLock(file))\n    }',
    scenarios: SECOND_CORE,
  },
  {
    name: 'a field named `List-Unsubscribe :` is read as List-Unsubscribe, though no signature covers it',
    file: unsubscribe('dkim.rs'),
    find: '            .filter(|(found, _)| found.eq_ignore_ascii_case(name.as_bytes()));',
    replace: '            .filter(|(found, _)| String::from_utf8_lossy(found).trim().eq_ignore_ascii_case(name));',
    scenarios: NOT_VOUCHED,
  },
  {
    name: 'a signature that does not cover From vouches for a one-click',
    file: unsubscribe('dkim.rs'),
    find: '    names("From") && names("List-Unsubscribe") && names("List-Unsubscribe-Post")',
    replace: '    names("List-Unsubscribe") && names("List-Unsubscribe-Post")',
    scenarios: NOT_VOUCHED,
  },
  {
    name: "a signature by any domain vouches for a one-click in another's mail",
    file: unsubscribe('dkim.rs'),
    find: '    let usable = |signature: &Signature| covers(signature) && aligned(signature, &from_domain);',
    replace: '    let usable = |signature: &Signature| covers(signature) || aligned(signature, &from_domain);',
    scenarios: NOT_VOUCHED,
  },
  {
    name: 'a one-click URL with a user name and password is posted',
    file: unsubscribe('dkim.rs'),
    find: '    if !parsed.username().is_empty() || parsed.password().is_some() {\n        return None;\n    }',
    replace: '    drop(parsed);',
    also: [
      {
        file: 'crates/host/src/web.rs',
        find: '        if userinfo.unwrap_or(true) {\n            return Posted::NotSent;\n        }',
        replace: '        drop(userinfo);',
      },
    ],
    scenarios: NOT_VOUCHED,
  },
  {
    name: 'the gmail adapter reads a raw source of any size',
    file: 'crates/gmail/src/adapter.rs',
    find: '        let encoded = limit.saturating_mul(4) / 3 + 4096;',
    replace: '        let encoded = usize::MAX;',
    also: [
      {
        file: 'crates/gmail/src/adapter.rs',
        find: '                Ok(if raw.len() > limit {',
        replace: '                Ok(if raw.len() > usize::MAX {',
      },
    ],
    scenarios: NOT_VOUCHED,
  },
  {
    name: 'the sim adapter passes on a raw source of any size',
    file: 'crates/sim-client/src/wire.rs',
    find: '            if bytes.len() > limit {',
    replace: '            if bytes.len() > usize::MAX {',
    scenarios: NOT_VOUCHED,
  },
  {
    name: 'a public suffix such as co.uk or github.io signs for every domain below it',
    file: unsubscribe('dkim.rs'),
    find: '    under(&signer, from_domain) && (signer == registrable || under(registrable, &signer))',
    replace: "    drop(registrable);\n    under(&signer, from_domain) && signer.contains('.')",
    scenarios: REGISTRABLE,
  },
]
