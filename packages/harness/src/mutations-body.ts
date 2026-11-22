// Breaks in the body pipeline (crates/core/src/body): trackers, remote images, unsubscribe
// targets and quoted history. mutations.ts runs them with the others.

import type { Mutation } from './breaks.ts'

const body = (file: string) => `crates/core/src/body/${file}`

const IMAGES = 'remote images wait until the user shows them'
const UNSUBSCRIBE = 'unsubscribe targets come from the headers'
const QUOTES = 'the quote at the end of a body'

export const BODY_MUTATIONS: Mutation[] = [
  {
    name: 'a 1x1 image is kept as a remote image, so it loads once images are shown',
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
    name: 'a tracker stays in the html, so it loads once images are shown',
    file: body('html.rs'),
    find: '            el.remove();\n            return Ok(());',
    replace: '            return Ok(());',
    scenarios: IMAGES,
  },
  {
    name: 'a tracker in a CSS background stays',
    file: body('html.rs'),
    find: '        (!gone.is_empty()).then(|| trackers::blank(css, &gone))\n    }\n\n    /// A srcset',
    replace: '        drop(gone);\n        None\n    }\n\n    /// A srcset',
    scenarios: IMAGES,
  },
  {
    name: "an attribute the sender wrote passes for one of the core's own",
    file: body('html.rs'),
    find: '.filter(|name| name.starts_with("data-letterbox-"))',
    replace: '.filter(|_| false)',
    scenarios: IMAGES,
  },
  {
    name: 'a remote CSS image loads while images are blocked',
    file: body('html.rs'),
    find: '            .filter(|found| trackers::remote(&found.url).is_some())\n            .collect();',
    replace: '            .filter(|_| false)\n            .collect();',
    scenarios: IMAGES,
  },
  {
    name: 'a video poster or an SVG image loads while images are blocked',
    file: body('html.rs'),
    find: '        if let Some(loads) = image_attribute(el, &name)\n            && let Some(at) = attribute(el, loads).and_then(|value| index(&value))',
    replace:
      '        if let Some(loads) = image_attribute(el, &name).filter(|_| false)\n            && let Some(at) = attribute(el, loads).and_then(|value| index(&value))',
    scenarios: IMAGES,
  },
  {
    name: 'showing images serves the html as it came, trackers and all',
    file: body('mod.rs'),
    find: '        _ => (processed.html.clone(), shown_at),',
    replace: '        _ => (body.html.clone(), shown_at),',
    scenarios: IMAGES,
  },
  {
    name: "the user's choice to show images is ignored",
    file: body('mod.rs'),
    find: '        (Some(blocked), ShowImages::Blocked) => (Some(blocked.clone()), blocked_at),',
    replace: '        (Some(blocked), _) => (Some(blocked.clone()), blocked_at),',
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
    name: 'blocked html is folded at the offset of the shown html',
    file: body('mod.rs'),
    find: '        (Some(blocked), ShowImages::Blocked) => (Some(blocked.clone()), blocked_at),',
    replace: '        (Some(blocked), ShowImages::Blocked) => (Some(blocked.clone()), shown_at),',
    scenarios: QUOTES,
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
    name: 'one-click is claimed without List-Unsubscribe-Post',
    file: body('unsubscribe.rs'),
    find: '    let one_click = headers\n        .list_unsubscribe_post\n        .trim()\n        .eq_ignore_ascii_case("List-Unsubscribe=One-Click");',
    replace: '    let one_click = true;',
    scenarios: UNSUBSCRIBE,
  },
  {
    name: 'an http List-Unsubscribe URL is offered',
    file: body('unsubscribe.rs'),
    find: '        .find(|url| url.scheme() == "https")\n        .map(|url| UnsubscribeWeb {',
    replace: '        .find(|url| url.scheme().starts_with("http"))\n        .map(|url| UnsubscribeWeb {',
    scenarios: UNSUBSCRIBE,
  },
  {
    name: 'an unsubscribe link in the quoted part is offered',
    file: body('mod.rs'),
    find: 'unsubscribe::link_in_text(&body.text[..text_quote.unwrap_or(body.text.len())])',
    replace: 'unsubscribe::link_in_text(&body.text)',
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
]
