// Breaks in the body pipeline (crates/core/src/body): trackers, remote images and their
// fetch, verified senders, unsubscribe targets, quoted history and when the pipeline runs.
// mutations.ts runs them with the others.

import type { Mutation } from './breaks.ts'

const body = (file: string) => `crates/core/src/body/${file}`

const IMAGES = 'remote images wait until the user shows them'
const FETCH = 'the core fetches a shown image'
const UNSUBSCRIBE = 'unsubscribe targets come from the headers'
const QUOTES = 'the quote at the end of a body'
const PROCESSING = 'a stored reading survives a restart'

export const BODY_MUTATIONS: Mutation[] = [
  {
    name: 'a 1x1 image is kept as a remote image, so it can be fetched once images are shown',
    file: body('trackers.rs'),
    find: '(Some(width), Some(height)) => width <= 1.0 && height <= 1.0 || width == 0.0 || height == 0.0,',
    replace: '(Some(_), Some(_)) => false,',
    scenarios: IMAGES,
  },
  {
    name: 'an image hidden with display:none is not a tracker',
    file: body('trackers.rs'),
    find: '|| property("display") == Some("none")',
    replace: '',
    scenarios: IMAGES,
  },
  {
    name: 'a known tracking host is judged by its file name only',
    file: body('trackers.rs'),
    find: '    if known {\n        return Some(Reason::KnownHost);',
    replace: '    if known && false {\n        return Some(Reason::KnownHost);',
    scenarios: IMAGES,
  },
  {
    name: 'attribute values are read as written, so an entity hides a tracker and garbles a link',
    file: body('html.rs'),
    find: '        .map(|value| html_escape::decode_html_entities(&value).into_owned())',
    replace: '',
    scenarios: 'remote images wait',
  },
  {
    name: 'a hidden or tiny image stays, as a remote image',
    file: body('rewrite.rs'),
    find: '            for url in &urls {\n                found.sort(url, Some(reason));\n            }\n            el.remove();\n            return;',
    replace: '            drop((urls, reason));',
    scenarios: IMAGES,
  },
  {
    name: 'a tracker in src takes the real image in its srcset with it',
    file: body('rewrite.rs'),
    find: '    let element = trackers::by_element(\n        width.as_deref(),\n        height.as_deref(),\n        style.as_deref(),\n        el.has_attribute("hidden"),\n    );',
    replace:
      '    let element = trackers::by_element(\n        width.as_deref(),\n        height.as_deref(),\n        style.as_deref(),\n        el.has_attribute("hidden"),\n    )\n    .or(attribute(el, "src").as_deref().and_then(trackers::remote).and_then(|url| trackers::by_url(&url)));',
    scenarios: IMAGES,
  },
  {
    name: 'a tracker in a CSS background stays',
    file: body('rewrite.rs'),
    find: '                Some(Verdict::Drop) => "none".to_owned(),',
    replace: '                Some(Verdict::Drop) => continue,',
    scenarios: IMAGES,
  },
  {
    name: "an attribute the sender wrote passes for one of the core's own",
    file: body('rewrite.rs'),
    find: '.filter(|name| name.starts_with("data-letterbox-"))',
    replace: '.filter(|_| false)',
    scenarios: IMAGES,
  },
  {
    name: 'a remote CSS image keeps its URL instead of becoming a placeholder',
    file: body('rewrite.rs'),
    find: '                Some(Verdict::Place(index)) => format!("var(--letterbox-image-{index}, none)"),',
    replace: '                Some(Verdict::Place(_)) => continue,',
    scenarios: IMAGES,
  },
  {
    name: 'a video poster or an SVG image keeps its URL instead of becoming a placeholder',
    file: body('rewrite.rs'),
    find: '            el.remove_attribute(loads);\n            if let Verdict::Place(index) = verdict {\n                set(el, "data-letterbox-image", &index.to_string());',
    replace:
      '            if let Verdict::Place(index) = verdict {\n                set(el, "data-letterbox-image", &index.to_string());',
    scenarios: IMAGES,
  },
  {
    name: 'an image beside a local src is listed though nothing names it',
    file: body('rewrite.rs'),
    find: '            if reason.is_none() && !list {',
    replace: '            if reason.is_none() && !list && false {',
    scenarios: IMAGES,
  },
  {
    name: 'a noscript is read as text, so the image in it is never judged',
    file: body('html.rs'),
    find: '            el.remove_and_keep_content();',
    replace: '            let _ = el;',
    scenarios: IMAGES,
  },
  {
    name: "a sender's base href stays, so relative images point at the sender",
    file: body('html.rs'),
    find: '        .append_element_content_handler(element!("base", |el| {\n            el.remove();',
    replace: '        .append_element_content_handler(element!("base", |el| {\n            let _ = el;',
    scenarios: IMAGES,
  },
  {
    name: 'a blocked image shows without its alt text',
    file: body('rewrite.rs'),
    find: '    line.push_str(&html_escape::encode_text(alt.trim()));',
    replace: '    line.push_str(&html_escape::encode_text(&alt[..0]));',
    scenarios: IMAGES,
  },
  {
    name: "a sender's address is matched with its case, so their other mail stays blocked",
    file: body('mod.rs'),
    find: '    let address = record.facts.from.address.to_lowercase();\n    let account = world.accounts.get(&record.account_id);',
    replace:
      '    let address = record.facts.from.address.clone();\n    let account = world.accounts.get(&record.account_id);',
    scenarios: IMAGES,
  },
  {
    name: "a message's own choice to show images is lost on restart",
    file: body('mod.rs'),
    find: '    #[serde(default, skip_serializing_if = "std::ops::Not::not")]\n    show_images: bool,',
    replace: '    #[serde(skip)]\n    show_images: bool,',
    scenarios: IMAGES,
  },
  {
    name: 'mail that only claims an always-shown address shows its images',
    file: body('mod.rs'),
    find: '    let trusted = record.facts.sender_verified && !address.is_empty();',
    replace: '    let trusted = !address.is_empty();',
    scenarios: IMAGES,
  },
  {
    name: 'an unverified sender can be always shown',
    file: body('mod.rs'),
    find: '        if show == ShowImages::Sender && (!record.facts.sender_verified || address.is_empty()) {',
    replace: '        if show == ShowImages::Sender && address.is_empty() {',
    scenarios: IMAGES,
  },
  {
    name: 'the Gmail adapter trusts an Authentication-Results any server wrote',
    file: 'crates/gmail/src/message.rs',
    find: '    if !authserv.eq_ignore_ascii_case("mx.google.com") {',
    replace: '    if authserv.is_empty() {',
    scenarios: IMAGES,
  },
  {
    name: 'the core fetches an image while the message blocks images',
    file: body('fetch.rs'),
    find: '                if shown(world, record) == ShowImages::Blocked {',
    replace: '                if shown(world, record) == ShowImages::Blocked && false {',
    scenarios: FETCH,
  },
  {
    name: 'a redirect to a tracker is followed',
    file: body('fetch.rs'),
    find: '        if next.scheme() != "https" || trackers::by_url(&next).is_some() {',
    replace: '        if next.scheme() != "https" {',
    scenarios: FETCH,
  },
  {
    name: 'a redirect away from https is followed',
    file: body('fetch.rs'),
    find: '        if next.scheme() != "https" || trackers::by_url(&next).is_some() {',
    replace: '        if trackers::by_url(&next).is_some() {',
    scenarios: FETCH,
  },
  {
    name: 'what a server sends is passed on whatever its type',
    file: body('fetch.rs'),
    find: '            Fetched::Body { mime, bytes } if mime.starts_with("image/") => return Ok((mime, bytes)),',
    replace: '            Fetched::Body { mime, bytes } => return Ok((mime, bytes)),',
    scenarios: FETCH,
  },
  {
    name: 'a quote offset counts bytes, which JavaScript does not',
    file: body('mod.rs'),
    find: 'let units = |text: &str, at: usize| text[..at].encode_utf16().count() as u64;',
    replace: 'let units = |_: &str, at: usize| at as u64;',
    scenarios: QUOTES,
  },
  {
    name: 'the attribution line is left in the new part',
    file: body('quote.rs'),
    find: '                boundary = if wrapped { before - 1 } else { before };',
    replace: '                let _ = wrapped;',
    scenarios: QUOTES,
  },
  {
    name: 'replies between quotes fold away with them',
    file: body('quote.rs'),
    find: '                Kind::Container => self.last_content.is_none_or(|pos| pos < candidate.end),',
    replace: '                Kind::Container => true,',
    scenarios: QUOTES,
  },
  {
    name: 'an Outlook html divider is not a quote',
    file: body('quote.rs'),
    find: '"div" if matches!(tag.id, "divRplyFwdMsg" | "appendonsend") => Some((Kind::Divider, at)),',
    replace: '"div" if false => Some((Kind::Divider, at)),',
    scenarios: QUOTES,
  },
  {
    name: 'a quote is said to repeat this conversation without looking at what it replies to',
    file: body('mod.rs'),
    find: '    !references.is_empty() && references.iter().all(held)',
    replace: '    let _ = (references, held);\n    true',
    scenarios: QUOTES,
  },
  {
    name: 'a folded row previews the quoted text too',
    file: body('mod.rs'),
    find: '            preview: preview_of(new_text),',
    replace: '            preview: preview_of(&body.text),',
    scenarios: QUOTES,
  },
  {
    name: 'one-click is claimed without List-Unsubscribe-Post',
    file: body('unsubscribe.rs'),
    find: '    let one_click = headers\n        .list_unsubscribe_post\n        .trim()\n        .eq_ignore_ascii_case("List-Unsubscribe=One-Click");',
    replace: '    let one_click = true;',
    scenarios: UNSUBSCRIBE,
  },
  {
    name: 'an http List-Unsubscribe URL is offered',
    file: body('unsubscribe.rs'),
    find: '        .filter(|url| matches!(url.scheme(), "https" | "mailto"))',
    replace: '        .filter(|url| matches!(url.scheme(), "https" | "http" | "mailto"))',
    scenarios: UNSUBSCRIBE,
  },
  {
    name: 'List-Unsubscribe is read past an entry outside brackets',
    file: body('unsubscribe.rs'),
    find: "    while let Some(inner) = rest.strip_prefix('<') {",
    replace: "    while let Some(inner) = rest.find('<').map(|at| &rest[at + 1..]) {",
    scenarios: UNSUBSCRIBE,
  },
  {
    name: 'a comment in List-Unsubscribe ends the reading',
    file: body('unsubscribe.rs'),
    find: "    while rest.starts_with('(') {",
    replace: "    while rest.starts_with('(') && false {",
    scenarios: UNSUBSCRIBE,
  },
  {
    name: 'an unsubscribe link in the quoted part is offered',
    file: body('mod.rs'),
    find: '    let text_link = || unsubscribe::link_in_text(new_text);',
    replace: '    let text_link = || unsubscribe::link_in_text(&body.text);',
    scenarios: UNSUBSCRIBE,
  },
  {
    name: "a sender's row in Updates never says how to unsubscribe",
    file: 'crates/core/src/rows.rs',
    find: '        unsubscribe: crate::body::unsubscribe_of(newest),',
    replace: '        unsubscribe: None,',
    scenarios: UNSUBSCRIBE,
  },
  {
    name: 'the Gmail adapter does not fetch List-Unsubscribe-Post',
    file: 'crates/gmail/src/message.rs',
    find: '    "List-Unsubscribe-Post",\n',
    replace: '    "X-List-Unsubscribe-Post",\n',
    scenarios: UNSUBSCRIBE,
  },
  {
    name: 'the store forgets each reading, so a restart processes every body again',
    file: body('mod.rs'),
    find: '    #[serde(default, skip_serializing_if = "Option::is_none")]\n    processed: Option<Processed>,',
    replace: '    #[serde(skip)]\n    processed: Option<Processed>,',
    scenarios: PROCESSING,
  },
  {
    name: 'a stored body the rules changed for is never processed again',
    file: 'crates/core/src/subscriptions.rs',
    find: '        self.reprocess(unprocessed);',
    replace: '        drop(unprocessed);',
    scenarios: PROCESSING,
  },
  {
    name: 'a large forward is processed before its send is accepted',
    file: body('mod.rs'),
    find: '        if size > SEND_LIMIT {',
    replace: '        if size > SEND_LIMIT && false {',
    scenarios: 'a large sent body',
  },
]
