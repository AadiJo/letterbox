//! The passes over an HTML body. lol_html reads the markup with the HTML standard's tokenizer
//! and edits it in place, so everything the passes do not touch stays byte for byte.
//!   0. `unwrap` makes the markup read as the renderer's frame reads it: it takes the tags off
//!      every `<noscript>`, whose content lol_html reads as text but a frame with scripts off
//!      reads as markup.
//!   1. `scan` reads the body: where its quote starts (quote.rs), its text before the quote,
//!      and its unsubscribe links.
//!   2. `rewrite` (rewrite.rs) writes the body a UI shows. It drops every `<base>`, so no
//!      relative URL resolves against a sender's address, every `<link>`, since a browser acts
//!      on DNS-prefetch, preconnect and prefetch hints outside the frame's image policy and a
//!      hint would tell a sender's resolver the mail was opened, and every `<meta http-equiv>`,
//!      which could turn prefetching back on or set a refresh. It drops every element that embeds
//!      a document of its own (`iframe`, `frame`, `frameset`, `object`, `embed`, `portal`,
//!      `applet`): no pass reads an iframe's `srcdoc`, and a browser acts on hints in it apart from
//!      this document's opt-outs. It runs on pass 0's result, so a hint that was inside a
//!      `<noscript>` goes too, and lol_html reads what an SVG `<foreignObject>` or a `<template>`
//!      holds as markup, so a hint there goes the same way. Then: trackers taken out (trackers.rs), each remote
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

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use lol_html::html_content::Element;
use lol_html::{RewriteStrSettings, doc_text, element, end_tag, rewrite_str, text};

use super::quote::{self, Place, Scan, Tag};
use super::rewrite::{Found, rewrite};
use super::trackers::{self, Reason};
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

/// Runs the passes, writing CSS custom property names that start with `prefix`. None when lol_html refuses the markup, as it does when the markup is
/// ambiguous enough that it cannot be sure how a browser would read it, or when the check on
/// the result (`safe`) finds what the passes should have taken out: then the caller shows the
/// plain text instead, and says the HTML was withheld.
pub fn process(input: &str, prefix: &str) -> Option<Html> {
    let input = unwrap(input)?;
    let Scanned { boundary, words, link } = scan(&input)?;
    let marker = boundary.map(|_| marker_for(&input));
    let mut found = Found::with_prefix(prefix);
    let rewritten = rewrite(
        &input,
        boundary.map(|place| place.ordinal),
        marker.as_deref(),
        &mut found,
    )?;
    let (html, quote) = take_marker(rewritten, marker.as_deref());
    if !safe(&html) {
        return None;
    }
    Some(Html {
        html,
        remote: found.remote,
        trackers: found.trackers,
        quote,
        words,
        link,
    })
}

/// How many times pass 0 takes the tags off `<noscript>`s nested in each other. A noscript left
/// after that goes whole, in pass 0 too.
const NOSCRIPT_DEPTH: usize = 4;

/// Pass 0: every `<noscript>` without its tags. lol_html reads a noscript's content as text, so
/// one nested in another only becomes markup once the outer one is unwrapped: the pass runs
/// again while a noscript is left, up to NOSCRIPT_DEPTH times, and drops one left after that. The
/// hints in what this uncovers (`<base>`, `<link>`, `<meta http-equiv>`, embedded documents) go
/// in pass 2, which reads the result as markup.
fn unwrap(input: &str) -> Option<String> {
    let mut html = input.to_owned();
    for _ in 0..NOSCRIPT_DEPTH {
        if !html.to_ascii_lowercase().contains("<noscript") {
            break;
        }
        let settings = RewriteStrSettings::new().append_element_content_handler(element!("noscript", |el| {
            el.remove_and_keep_content();
            Ok(())
        }));
        html = rewrite_str(&html, settings).ok()?;
    }
    // A noscript still left goes whole here, before the scan, so the scan and the frame see the
    // same content: its raw text never reaches a preview or an enclosing link's text.
    if html.to_ascii_lowercase().contains("<noscript") {
        let settings = RewriteStrSettings::new().append_element_content_handler(element!("noscript", |el| {
            el.remove();
            Ok(())
        }));
        html = rewrite_str(&html, settings).ok()?;
    }
    Some(html)
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

/// The check on what the frame will get, after every pass and the marker are done: the HTML
/// read once more, as markup, failing closed. False when lol_html refuses it, or it holds an
/// element the passes take out (`base`, `link`, `meta http-equiv`, `script`, `noscript`, and
/// every embedded document), or a remote URL where the frame could load it: in `src`, `srcset`,
/// `poster` or `background`, in `href` or `xlink:href` on anything but a link (`a`, `area`),
/// or in a `url()` of a style attribute or `<style>`. The passes leave none of these, so a false
/// here means a gap in them, such as an image attribute they do not know (an SVG `feImage`, a
/// `video`'s src): the HTML is withheld rather than passed on.
fn safe(html: &str) -> bool {
    let bad = &Cell::new(false);
    let on_element = element!("*", move |el| {
        let name = el.tag_name();
        let forbidden = matches!(
            name.as_str(),
            "base"
                | "link"
                | "script"
                | "noscript"
                | "iframe"
                | "frame"
                | "frameset"
                | "object"
                | "embed"
                | "portal"
                | "applet"
        ) || name == "meta" && el.has_attribute("http-equiv");
        let remote = |name: &str| attribute(el, name).is_some_and(|value| trackers::remote(&value).is_some());
        let link = matches!(name.as_str(), "a" | "area");
        let in_srcset = attribute(el, "srcset").is_some_and(|value| {
            trackers::srcset(&value)
                .iter()
                .any(|candidate| trackers::remote(candidate.url).is_some())
        });
        let loads = ["src", "poster", "background"].into_iter().any(remote)
            || !link && ["href", "xlink:href"].into_iter().any(remote)
            || in_srcset
            || attribute(el, "style").is_some_and(|style| remote_css(&style));
        if forbidden || loads {
            bad.set(true);
        }
        Ok(())
    });
    let mut style = String::new();
    let on_style = text!("style", move |chunk| {
        style.push_str(chunk.as_str());
        if chunk.last_in_text_node() {
            if remote_css(&style) {
                bad.set(true);
            }
            style.clear();
        }
        Ok(())
    });
    let settings = RewriteStrSettings::new()
        .append_element_content_handler(on_element)
        .append_element_content_handler(on_style);
    rewrite_str(html, settings).is_ok() && !bad.get()
}

/// True when CSS names a remote image in a `url()` (see `trackers::css_urls`).
fn remote_css(css: &str) -> bool {
    trackers::css_urls(css)
        .iter()
        .any(|found| trackers::remote(&found.url).is_some())
}
