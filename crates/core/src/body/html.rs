//! The passes over an HTML body. lol_html reads the markup with the HTML standard's tokenizer
//! and edits it in place, so everything the passes do not touch stays byte for byte.
//!   1. `scan` reads the body: where its quote starts (quote.rs) and its unsubscribe links.
//!   2. `shown` writes the body with images shown: trackers taken out (trackers.rs), any
//!      `data-letterbox-` attribute the sender wrote dropped, and a marker comment before the
//!      element where the quote starts, which `Html::take_marker` turns into an offset.
//!   3. `blocked` rewrites that into the body with images blocked: each remote image a
//!      placeholder, and each remote CSS image `none`.
//!
//! An image is anything the renderer's `img-src` governs that the markup names: `<img>` src
//! and srcset, `<source>` srcset, an image `<input>`, a `<video>` poster, an SVG `<image>`,
//! the `background` attribute and CSS `url()` (trackers.rs).
//!
//! Attribute values come from lol_html as written, so each is read with its entities decoded
//! (`attribute`), as a browser reads it, and written back with `&` escaped (`set`).

use std::cell::RefCell;
use std::rc::Rc;

use lol_html::html_content::{ContentType, Element};
use lol_html::{RewriteStrSettings, doc_text, element, end_tag, rewrite_str, text};

use super::quote::{self, Place, Scan, Tag};
use super::trackers::{self, Candidate, Reason};
use super::unsubscribe::{self, Link};

/// What the passes made of one HTML body.
pub struct Html {
    /// With images shown.
    pub shown: String,
    /// With images blocked. None when there are no remote images, so it would be `shown`.
    pub blocked: Option<String>,
    pub remote: Vec<String>,
    /// Each tracker's host and why, in the order the body names them.
    pub trackers: Vec<(String, Reason)>,
    /// Where the quote starts, in bytes, in `shown` and in `blocked`.
    pub quote: Option<(usize, Option<usize>)>,
    pub link: Option<String>,
}

/// Runs the passes. None when lol_html refuses the markup, as it does when the markup is
/// ambiguous enough that it cannot be sure how a browser would read it: then the caller
/// shows the plain text instead.
pub fn process(input: &str) -> Option<Html> {
    let (boundary, link) = scan(input)?;
    let marker = boundary.map(|_| marker_for(input));
    let mut found = Found::default();
    let shown = shown(
        input,
        boundary.map(|place| place.ordinal),
        marker.as_deref(),
        &mut found,
    )?;
    let blocked = if found.remote.is_empty() {
        None
    } else {
        Some(blocked(&shown, &found.remote)?)
    };
    let (shown, at_shown) = take_marker(shown, marker.as_deref());
    let (blocked, at_blocked) = match blocked {
        Some(blocked) => {
            let (blocked, at) = take_marker(blocked, marker.as_deref());
            (Some(blocked), at)
        }
        None => (None, None),
    };
    Some(Html {
        shown,
        blocked,
        remote: found.remote,
        trackers: found.trackers,
        quote: at_shown.map(|at| (at, at_blocked)),
        link,
    })
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
fn attribute(element: &Element<'_, '_>, name: &str) -> Option<String> {
    element
        .get_attribute(name)
        .map(|value| html_escape::decode_html_entities(&value).into_owned())
}

/// The attribute through which an element other than `<img>` loads one image, as the renderer's
/// `img-src` governs it: an image `<input>`'s src, a `<video>`'s poster, an SVG `<image>`'s href.
fn image_attribute(element: &Element<'_, '_>, name: &str) -> Option<&'static str> {
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
fn set(element: &mut Element<'_, '_>, name: &str, value: &str) {
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
}

/// Pass 1: where the quote starts, and the best unsubscribe link before it.
fn scan(input: &str) -> Option<(Option<Place>, Option<String>)> {
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
    Some((boundary, links.first().map(|(_, _, url)| url.clone())))
}

/// What pass 2 found.
#[derive(Default)]
struct Found {
    remote: Vec<String>,
    trackers: Vec<(String, Reason)>,
}

impl Found {
    /// Sorts one remote URL: a tracker when `reason` is set, else a remote image. True for a tracker.
    fn sort(&mut self, url: &url::Url, reason: Option<Reason>) -> bool {
        match reason {
            Some(reason) => {
                self.trackers.push((trackers::host(url), reason));
                true
            }
            None => {
                let url = url.to_string();
                if !self.remote.contains(&url) {
                    self.remote.push(url);
                }
                false
            }
        }
    }

    /// The CSS with its trackers set to `none`, noting every remote image in it. None when it needs no change.
    fn css(&mut self, css: &str) -> Option<String> {
        let urls = trackers::css_urls(css);
        let mut gone = Vec::new();
        for found in &urls {
            if let Some(url) = trackers::remote(&found.url)
                && self.sort(&url, trackers::by_url(&url))
            {
                gone.push(found);
            }
        }
        (!gone.is_empty()).then(|| trackers::blank(css, &gone))
    }

    /// A srcset without its trackers, noting its remote images. None when it needs no change.
    fn srcset(&mut self, value: &str, element: Option<Reason>) -> Option<String> {
        let candidates = trackers::srcset(value);
        let before = candidates.len();
        let kept: Vec<Candidate<'_>> = candidates
            .into_iter()
            .filter(|candidate| match trackers::remote(candidate.url) {
                Some(url) => !self.sort(&url, trackers::by_url(&url).or(element)),
                None => true,
            })
            .collect();
        (kept.len() < before).then(|| trackers::join_srcset(&kept))
    }
}

/// Pass 2: the body with images shown.
fn shown(input: &str, boundary: Option<u32>, marker: Option<&str>, found: &mut Found) -> Option<String> {
    let found = &RefCell::new(found);
    let mut ordinal = 0;
    let on_element = element!("*", move |el| {
        ordinal += 1;
        if boundary == Some(ordinal)
            && let Some(marker) = marker
        {
            el.before(marker, ContentType::Html);
        }
        let ours: Vec<String> = el
            .attributes()
            .iter()
            .map(|attribute| attribute.name())
            .filter(|name| name.starts_with("data-letterbox-"))
            .collect();
        for name in ours {
            el.remove_attribute(&name);
        }
        let mut found = found.borrow_mut();
        if let Some(background) = attribute(el, "background")
            && let Some(url) = trackers::remote(&background)
            && found.sort(&url, trackers::by_url(&url))
        {
            el.remove_attribute("background");
        }
        if let Some(style) = attribute(el, "style")
            && let Some(css) = found.css(&style)
        {
            set(el, "style", &css);
        }
        let name = el.tag_name();
        let reason = (name == "img").then(|| {
            let (width, height, style) = (attribute(el, "width"), attribute(el, "height"), attribute(el, "style"));
            trackers::by_element(
                width.as_deref(),
                height.as_deref(),
                style.as_deref(),
                el.has_attribute("hidden"),
            )
        });
        let reason = reason.flatten();
        if name == "img"
            && let Some(src) = attribute(el, "src")
            && let Some(url) = trackers::remote(&src)
            && found.sort(&url, trackers::by_url(&url).or(reason))
        {
            el.remove();
            return Ok(());
        }
        if matches!(name.as_str(), "img" | "source")
            && let Some(srcset) = attribute(el, "srcset")
            && let Some(kept) = found.srcset(&srcset, reason)
        {
            set(el, "srcset", &kept);
        }
        if let Some(loads) = image_attribute(el, &name)
            && let Some(url) = attribute(el, loads).and_then(|value| trackers::remote(&value))
            && found.sort(&url, trackers::by_url(&url))
        {
            el.remove_attribute(loads);
        }
        Ok(())
    });
    let mut style = String::new();
    let on_style = text!("style", move |chunk| {
        style.push_str(chunk.as_str());
        if chunk.last_in_text_node() {
            let css = std::mem::take(&mut style);
            let rewritten = found.borrow_mut().css(&css).unwrap_or(css);
            chunk.replace(&rewritten, ContentType::Html);
        } else {
            chunk.remove();
        }
        Ok(())
    });
    let settings = RewriteStrSettings::new()
        .append_element_content_handler(on_element)
        .append_element_content_handler(on_style);
    rewrite_str(input, settings).ok()
}

/// Pass 3: the body with images blocked, from the body with images shown and its remote images.
fn blocked(shown: &str, remote: &[String]) -> Option<String> {
    let index = &|value: &str| {
        let url = trackers::remote(value)?.to_string();
        remote.iter().position(|known| *known == url)
    };
    let blank = &|css: &str| {
        let urls = trackers::css_urls(css);
        let gone: Vec<_> = urls
            .iter()
            .filter(|found| trackers::remote(&found.url).is_some())
            .collect();
        (!gone.is_empty()).then(|| trackers::blank(css, &gone))
    };
    let on_element = element!("*", move |el| {
        if let Some(at) = attribute(el, "background").and_then(|value| index(&value)) {
            el.remove_attribute("background");
            set(el, "data-letterbox-background", &at.to_string());
        }
        if let Some(css) = attribute(el, "style").and_then(|style| blank(&style)) {
            set(el, "style", &css);
        }
        let name = el.tag_name();
        if let Some(loads) = image_attribute(el, &name)
            && let Some(at) = attribute(el, loads).and_then(|value| index(&value))
        {
            el.remove_attribute(loads);
            set(el, "data-letterbox-image", &at.to_string());
        }
        if !matches!(name.as_str(), "img" | "source") {
            return Ok(());
        }
        let from_src = (name == "img")
            .then(|| attribute(el, "src").and_then(|src| index(&src)))
            .flatten();
        let from_srcset = attribute(el, "srcset").and_then(|srcset| {
            let candidates = trackers::srcset(&srcset);
            candidates.iter().find_map(|candidate| index(candidate.url))
        });
        if from_src.is_some() {
            el.remove_attribute("src");
        }
        if from_srcset.is_some() {
            el.remove_attribute("srcset");
        }
        if name == "img"
            && let Some(at) = from_src.or(from_srcset)
        {
            set(el, "data-letterbox-image", &at.to_string());
        }
        Ok(())
    });
    let mut style = String::new();
    let on_style = text!("style", move |chunk| {
        style.push_str(chunk.as_str());
        if chunk.last_in_text_node() {
            let css = std::mem::take(&mut style);
            chunk.replace(&blank(&css).unwrap_or(css), ContentType::Html);
        } else {
            chunk.remove();
        }
        Ok(())
    });
    let settings = RewriteStrSettings::new()
        .append_element_content_handler(on_element)
        .append_element_content_handler(on_style);
    rewrite_str(shown, settings).ok()
}
