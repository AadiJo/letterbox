//! The passes over an HTML body. lol_html reads the markup with the HTML standard's tokenizer
//! and edits it in place, so everything the passes do not touch stays byte for byte.
//!   0. `unwrap` makes the markup read as the renderer's frame reads it: it takes the tags off
//!      every `<noscript>`, whose content lol_html reads as text but a frame with scripts off
//!      reads as markup, and drops every `<base>`, so no relative URL resolves against a
//!      sender's address. It drops every `<link>` too, since a browser acts on DNS-prefetch,
//!      preconnect and prefetch hints outside the frame's image policy, so a hint would tell a
//!      sender's resolver the mail was opened, and every `<meta http-equiv>`, which could turn
//!      prefetching back on or set a refresh.
//!   1. `scan` reads the body: where its quote starts (quote.rs), its text before the quote,
//!      and its unsubscribe links.
//!   2. `rewrite` (rewrite.rs) writes the body a UI shows: trackers taken out (trackers.rs), each remote
//!      image a placeholder that names its index in `Html::remote`, any `data-letterbox-`
//!      attribute the sender wrote dropped, and a marker comment before the element where the
//!      quote starts, which `take_marker` turns into an offset.
//!
//! An image is anything the renderer's `img-src` governs that the markup names: `<img>` src
//! and srcset, `<source>` srcset, an image `<input>`, a `<video>` poster, an SVG `<image>`,
//! the `background` attribute and CSS `url()` (trackers.rs). The renderer never reaches the
//! network, so a URL the passes miss, such as one in a CSS `image-set()`, never loads, and the
//! core fetches only what `remote` lists (fetch.rs).
//!
//! Attribute values come from lol_html as written, so each is read with its entities decoded
//! (`attribute`), as a browser reads it, and written back with `&` escaped (`set`).

use std::cell::RefCell;
use std::rc::Rc;

use lol_html::html_content::Element;
use lol_html::{RewriteStrSettings, doc_text, element, end_tag, rewrite_str};

use super::quote::{self, Place, Scan, Tag};
use super::rewrite::{Found, rewrite};
use super::trackers::Reason;
use super::unsubscribe::{self, Link};

/// What the passes made of one HTML body.
pub struct Html {
    pub html: String,
    /// The remote images the placeholders name, by index.
    pub remote: Vec<String>,
    /// Each tracker's host and why, in the order the body names them.
    pub trackers: Vec<(String, Reason)>,
    /// Where the quote starts in `html`, in bytes.
    pub quote: Option<usize>,
    /// The text before the quote, as written, entities decoded, for the message's preview.
    pub words: String,
    pub link: Option<String>,
}

/// Runs the passes. None when lol_html refuses the markup, as it does when the markup is
/// ambiguous enough that it cannot be sure how a browser would read it: then the caller
/// shows the plain text instead.
pub fn process(input: &str) -> Option<Html> {
    let input = unwrap(input)?;
    let Scanned { boundary, words, link } = scan(&input)?;
    let marker = boundary.map(|_| marker_for(&input));
    let mut found = Found::default();
    let rewritten = rewrite(
        &input,
        boundary.map(|place| place.ordinal),
        marker.as_deref(),
        &mut found,
    )?;
    let (html, quote) = take_marker(rewritten, marker.as_deref());
    Some(Html {
        html,
        remote: found.remote,
        trackers: found.trackers,
        quote,
        words,
        link,
    })
}

/// Pass 0: every `<noscript>` without its tags, and no `<base>`, `<link>` or `<meta http-equiv>`.
fn unwrap(input: &str) -> Option<String> {
    let settings = RewriteStrSettings::new()
        .append_element_content_handler(element!("noscript", |el| {
            el.remove_and_keep_content();
            Ok(())
        }))
        .append_element_content_handler(element!("base, link, meta[http-equiv]", |el| {
            el.remove();
            Ok(())
        }));
    rewrite_str(input, settings).ok()
}

/// A comment the body does not already hold, so the one pass 2 writes is the only one.
fn marker_for(input: &str) -> String {
    let free = (0..).find(|n| !input.contains(&format!("letterbox-quote-{n}")));
    format!("<!--letterbox-quote-{}-->", free.unwrap_or_default())
}

/// Takes the marker out, and says where it was.
fn take_marker(mut html: String, marker: Option<&str>) -> (String, Option<usize>) {
    let Some(at) = marker.and_then(|marker| html.find(marker).map(|at| (at, marker.len()))) else {
        return (html, None);
    };
    html.replace_range(at.0..at.0 + at.1, "");
    (html, Some(at.0))
}

/// An attribute's value with its entities decoded, as a browser reads it.
pub(super) fn attribute(element: &Element<'_, '_>, name: &str) -> Option<String> {
    element
        .get_attribute(name)
        .map(|value| html_escape::decode_html_entities(&value).into_owned())
}

/// The attribute through which an element other than `<img>` loads one image, as the renderer's
/// `img-src` governs it: an image `<input>`'s src, a `<video>`'s poster, an SVG `<image>`'s href.
pub(super) fn image_attribute(element: &Element<'_, '_>, name: &str) -> Option<&'static str> {
    match name {
        "input" if attribute(element, "type").is_some_and(|kind| kind.trim().eq_ignore_ascii_case("image")) => {
            Some("src")
        }
        "video" => Some("poster"),
        "image" if element.has_attribute("href") => Some("href"),
        "image" => Some("xlink:href"),
        _ => None,
    }
}

/// Sets an attribute to a value read with `attribute`. lol_html escapes quotes; `&` is escaped here.
pub(super) fn set(element: &mut Element<'_, '_>, name: &str, value: &str) {
    let written = element.set_attribute(name, &value.replace('&', "&amp;"));
    debug_assert!(written.is_ok(), "the passes set only valid attribute names");
}

/// What pass 1 holds between handlers. End-tag handlers outlive the pass's borrow, so it is shared.
#[derive(Default)]
struct Reading {
    scan: Scan,
    ordinal: u32,
    pos: u32,
    /// How deep the pass is in elements whose text is not shown: style, script, title, template.
    hidden: u32,
    /// The `<a>` being read: its ordinal, its href and its text so far.
    anchor: Option<(u32, String, String)>,
    /// Each unsubscribe link: its ordinal, how it looks and its URL.
    links: Vec<(u32, Link, String)>,
    /// The first of the shown text, chunk by chunk, each with its pos, for the preview.
    words: Vec<(u32, String)>,
    /// The bytes of text in `words`, which stops at PREVIEW_TEXT.
    worded: usize,
}

/// How much shown text pass 1 keeps for a preview. A preview takes the first 200 characters of
/// the new part, and the rest gives room for markup between them.
const PREVIEW_TEXT: usize = 2048;

/// What pass 1 found.
struct Scanned {
    boundary: Option<Place>,
    words: String,
    link: Option<String>,
}

/// Pass 1: where the quote starts and what it holds, the text before it, and the best unsubscribe link before it.
fn scan(input: &str) -> Option<Scanned> {
    let reading = Rc::new(RefCell::new(Reading::default()));
    let (elements, texts) = (Rc::clone(&reading), Rc::clone(&reading));
    let on_element = element!("*", move |el| {
        let name = el.tag_name();
        let at = {
            let mut reading = elements.borrow_mut();
            reading.ordinal += 1;
            reading.pos += 1;
            Place {
                ordinal: reading.ordinal,
                pos: reading.pos,
            }
        };
        let read = |attribute_name| attribute(el, attribute_name).unwrap_or_default();
        let (class, id, kind, style) = (read("class"), read("id"), read("type"), read("style"));
        let tag = Tag {
            name: &name,
            class: &class,
            id: &id,
            r#type: &kind,
            style: &style,
        };
        let candidate = {
            let mut reading = elements.borrow_mut();
            if name == "img" {
                reading.scan.content(at.pos);
            }
            if name == "a" {
                reading.anchor = Some((at.ordinal, read("href"), String::new()));
            }
            if matches!(name.as_str(), "style" | "script" | "title" | "template") {
                reading.hidden += 1;
            }
            reading.scan.element(at, &tag)
        };
        let shared = Rc::clone(&elements);
        if let Some(handlers) = el.end_tag_handlers() {
            handlers.push(end_tag!(move |_| {
                let mut reading = shared.borrow_mut();
                reading.pos += 1;
                let pos = reading.pos;
                if let Some(index) = candidate {
                    reading.scan.ended(index, pos);
                }
                if matches!(name.as_str(), "style" | "script" | "title" | "template") {
                    reading.hidden = reading.hidden.saturating_sub(1);
                }
                if name == "a"
                    && let Some((ordinal, href, text)) = reading.anchor.take()
                    && let Some(look) = unsubscribe::link(&href, &text)
                {
                    reading.links.push((ordinal, look, href.trim().to_owned()));
                }
                Ok(())
            }));
        }
        Ok(())
    });
    let on_text = doc_text!(move |chunk| {
        let mut reading = texts.borrow_mut();
        if reading.hidden > 0 {
            return Ok(());
        }
        let (pos, text) = (reading.pos, chunk.as_str());
        if !quote::blank(text) {
            reading.scan.content(pos);
        }
        reading.scan.text(pos, text);
        if reading.worded < PREVIEW_TEXT {
            reading.worded += text.len();
            reading.words.push((pos, text.to_owned()));
        }
        if let Some((_, _, anchor_text)) = &mut reading.anchor
            && anchor_text.len() < 200
        {
            anchor_text.push_str(text);
        }
        Ok(())
    });
    let settings = RewriteStrSettings::new()
        .append_element_content_handler(on_element)
        .append_document_content_handler(on_text);
    rewrite_str(input, settings).ok()?;
    let reading = reading.borrow();
    let boundary = reading.scan.boundary();
    let before = |ordinal: u32| boundary.is_none_or(|place| ordinal < place.ordinal);
    let mut links: Vec<&(u32, Link, String)> = reading.links.iter().filter(|link| before(link.0)).collect();
    links.sort_by_key(|(ordinal, look, _)| (std::cmp::Reverse(*look), *ordinal));
    let words: String = reading
        .words
        .iter()
        .filter(|(pos, _)| boundary.is_none_or(|place| *pos < place.pos))
        .map(|(_, text)| format!(" {text}"))
        .collect();
    Some(Scanned {
        boundary,
        words: html_escape::decode_html_entities(&words).into_owned(),
        link: links.first().map(|(_, _, url)| url.clone()),
    })
}
