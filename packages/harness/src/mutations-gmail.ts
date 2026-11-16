// Breaks in the Gmail adapter (crates/gmail). mutations.ts runs them with the core's breaks.

import type { Mutation } from './breaks.ts'

const gmail = (file: string) => `crates/gmail/src/${file}`

export const GMAIL_MUTATIONS: Mutation[] = [
  {
    name: 'gmail: a send after a crash does not search first, so Gmail gets it twice',
    file: gmail('send.rs'),
    find: '        if outgoing.maybe_sent\n',
    replace: '        if outgoing.maybe_sent && false\n',
    scenarios: 'killed in the middle of a delivery',
  },
  {
    name: 'gmail: bcc recipients never get the message',
    file: gmail('send.rs'),
    find: 'URL_SAFE.encode(outgoing.raw_with_bcc())',
    replace: 'URL_SAFE.encode(&outgoing.raw)',
    scenarios: 'a new message starts',
  },
  {
    name: 'gmail: STARRED shows up as a mailbox',
    file: gmail('labels.rs'),
    find: 'None if label.kind.as_deref() == Some("system") || !is_mailbox_id(&label.id) => return None,',
    replace:
      'None if label.id != STARRED && (label.kind.as_deref() == Some("system") || !is_mailbox_id(&label.id)) => return None,',
    scenarios: 'UNREAD and STARRED become flags',
  },
  {
    name: 'gmail: a label changed on another device is lost by the next sync',
    file: gmail('adapter.rs'),
    find: '                    touched.entry(id.id.clone()).or_default();',
    replace: '                    drop(id);',
    scenarios: 'read on another device',
  },
  {
    name: 'gmail: a label created on another device never becomes a mailbox',
    file: gmail('adapter.rs'),
    find: '        if labels != position.labels {',
    replace: '        if labels != position.labels && false {',
    scenarios: 'mailbox created on another device',
  },
  {
    name: 'gmail: mail in the promotions tab is not bulk',
    file: gmail('labels.rs'),
    find: '    Some(BULK_CATEGORIES.contains(&category.as_str()))',
    replace: '    Some(BULK_CATEGORIES.contains(&category.as_str()) && false)',
    scenarios: 'promotions tab',
  },
  {
    name: 'gmail: a revoked grant is retried forever instead of asking for a sign-in',
    file: gmail('oauth.rs'),
    find: '        Err(TokenFailure::InvalidGrant) => Err(AdapterFailure::NeedsSignIn),',
    replace: '        Err(TokenFailure::InvalidGrant) => Err(AdapterFailure::ProviderError),',
    scenarios: 'revoked gmail grant',
  },
  {
    name: 'gmail: one deleted message makes a change to its whole conversation fail',
    file: gmail('adapter.rs'),
    find: '                Err(error) if error.is_not_found() => {\n                    for id in chunk {',
    replace: '                Err(error) if error.is_not_found() && false => {\n                    for id in chunk {',
    scenarios: 'remain after one is deleted',
  },
  {
    name: 'gmail: a rate-limited call fails at once instead of waiting and trying again',
    file: gmail('api.rs'),
    find: 'if !error.is_rate_limit() || refused == RATE_LIMIT_TRIES {',
    replace: 'if !error.is_rate_limit() || refused >= 1 {',
    scenarios: 'far larger than one minute of quota',
  },
  {
    name: 'gmail: a call Gmail keeps refusing is retried forever',
    file: gmail('api.rs'),
    find: 'if !error.is_rate_limit() || refused == RATE_LIMIT_TRIES {',
    replace: 'if !error.is_rate_limit() {',
    scenarios: 'refused again and again',
  },
  {
    name: 'gmail: a Retry-After from Gmail is ignored for the usual backoff',
    file: gmail('api.rs'),
    find: '            let wait = retry_after.unwrap_or(backoff);\n',
    replace: '            let wait = retry_after.map_or(backoff, |_| backoff);\n',
    scenarios: 'during a rate-limit wait',
  },
  {
    name: 'gmail: every rate-limit wait is a flat second',
    file: gmail('api.rs'),
    find: '            backoff = (backoff * 2).min(MAX_BACKOFF);\n',
    replace: '',
    scenarios: 'refused again and again',
  },
  {
    name: 'gmail: the rate-limit backoff grows past a minute',
    file: gmail('api.rs'),
    find: '            backoff = (backoff * 2).min(MAX_BACKOFF);\n',
    replace: '            backoff *= 2;\n',
    scenarios: 'refused again and again',
  },
  {
    name: 'gmail: a short Retry-After is ignored for the usual backoff',
    file: gmail('api.rs'),
    find: '            let wait = retry_after.unwrap_or(backoff);\n',
    replace: '            let wait = retry_after.filter(|wait| *wait >= MAX_BACKOFF).unwrap_or(backoff);\n',
    scenarios: 'as long as the Retry-After',
  },
  {
    name: 'gmail: a daily limit is waited out like a rate limit',
    file: gmail('api.rs'),
    find: 'const RATE_LIMITS: [&str; 2] = ["rateLimitExceeded", "userRateLimitExceeded"];',
    replace: 'const RATE_LIMITS: [&str; 3] = ["rateLimitExceeded", "userRateLimitExceeded", "dailyLimitExceeded"];',
    scenarios: 'daily limit',
  },
  {
    name: 'gmail: a change made under a daily limit is refused as not permitted and undone',
    file: gmail('adapter.rs'),
    find: '            Err(error) if error.is_usage_limit() => Err(AdapterFailure::ProviderError),',
    replace: '            Err(error) if error.is_rate_limit() => Err(AdapterFailure::ProviderError),',
    scenarios: 'daily limit',
  },
  {
    name: 'gmail: a 429 is not waited out',
    file: gmail('api.rs'),
    find: '                *status == StatusCode::TOO_MANY_REQUESTS\n                    || ',
    replace: '                ',
    scenarios: 'a gmail 429',
  },
  {
    name: 'gmail: a page token Gmail no longer accepts is retried forever',
    file: gmail('adapter.rs'),
    find: 'if status == StatusCode::BAD_REQUEST && page.is_some() => {',
    replace: 'if status == StatusCode::BAD_REQUEST && page.is_some() && false => {',
    scenarios: 'page token the provider no longer accepts',
  },
  {
    name: 'gmail: a sign-out leaves a sync waiting out a rate limit, so the core never stops',
    file: gmail('adapter.rs'),
    find: '        self.api.close();\n',
    replace: '',
    scenarios: 'during a rate-limit wait',
  },
]
