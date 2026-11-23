//! Pass 2 over an HTML body (see html.rs): it writes the body a UI shows. Trackers come out
//! (trackers.rs), each remote image becomes a placeholder that names its index in `Found::remote`,
//! any `data-letterbox-` attribute the sender wrote is dropped, a marker comment goes before
//! the element where the quote starts, and every color is named (paint.rs).

use std::borrow::Cow;
use std::cell::{Cell, RefCell};
use std::rc::Rc;

use lol_html::html_content::{ContentType, Element};
use lol_html::{RewriteStrSettings, element, end_tag, rewrite_str, text};

use super::color::Rgba;
use super::fetch::MAX_IMAGES;
use super::html::{attribute, image_attribute, set};
use super::paint::{self, Painter};
use super::trackers::{self, Reason};
use crate::maps::HashMap;

/// What a deleted element leaves: an empty comment. Without it, the text on either side would
/// meet, and `<` before the element and `link href=…>` after it would read as a tag the passes
/// never saw. Nothing reparses this pass's output but the frame and the check in html.rs.
const BOUNDARY: &str = "<!---->";

/// Deletes an element, leaving BOUNDARY in its place.
fn delete(element: &mut Element<'_, '_>) {
    element.replace(BOUNDARY, ContentType::Html);
}

/// What pass 2 found.
#[derive(Default)]
pub(super) struct Found {
    pub(super) remote: Vec<String>,
    /// Each URL in `remote` and its index, so a lookup does not walk the list.
    places: HashMap<String, usize>,
    pub(super) trackers: Vec<(String, Reason)>,
    /// The colour pass, which runs in the same pass.
    pub(super) paint: Painter,
}

/// What pass 2 does with one remote URL.
#[derive(Clone, Copy)]
enum Verdict {
    /// Take it out: a tracker, or a remote image past MAX_IMAGES.
    Drop,
    /// Put a placeholder in, naming this index in `remote`.
    Place(usize),
}

impl Found {
    /// Sorts one remote URL: a tracker when `reason` is set, else a remote image, listed once.
    fn sort(&mut self, url: &url::Url, reason: Option<Reason>) -> Verdict {
        if let Some(reason) = reason {
            self.trackers.push((trackers::host(url), reason));
            return Verdict::Drop;
        }
        let url = url.to_string();
        if let Some(index) = self.places.get(&url) {
            return Verdict::Place(*index);
        }
        if self.remote.len() >= MAX_IMAGES {
            return Verdict::Drop;
        }
        self.places.insert(url.clone(), self.remote.len());
        self.remote.push(url);
        Verdict::Place(self.remote.len() - 1)
    }

    /// The verdict on a value that may name a remote URL, judged by the URL alone. None when it is not remote.
    fn judge(&mut self, value: &str) -> Option<Verdict> {
        let url = trackers::remote(value)?;
        let reason = trackers::by_url(&url);
        Some(self.sort(&url, reason))
    }

    /// The CSS with each tracker `none` and each remote image `var(--letterbox-image-i, none)`.
    /// None when it names no remote image.
    fn css(&mut self, css: &str) -> Option<String> {
        let mut changes = Vec::new();
        for found in trackers::css_urls(css) {
            let replacement = match self.judge(&found.url) {
                None => continue,
                Some(Verdict::Drop) => "none".to_owned(),
                Some(Verdict::Place(index)) => format!("var(--letterbox-image-{index}, none)"),
            };
            changes.push((found.start, found.end, replacement));
        }
        (!changes.is_empty()).then(|| trackers::replace(css, &changes))
    }

    /// CSS as pass 2 writes it: the sender's `--letterbox-` names renamed, each remote image
    /// a placeholder (`css`) and each color named (paint.rs), text against `on`, the background
    /// its element sets, for a style attribute. None when it is unchanged.
    fn restyle(&mut self, css: &str, on: Option<Rgba>) -> Option<String> {
        let own = paint::own(css);
        let images = self.css(&own);
        let colored = self.paint.css(images.as_deref().unwrap_or(&own), on);
        colored
            .or(images)
            .or_else(|| matches!(own, Cow::Owned(_)).then(|| own.into_owned()))
    }

    /// A srcset without its remote candidates, each judged, trackers with `element` too. A
    /// remote image is listed only with `list`, when a placeholder will name it. None when it
    /// has none. Returns the srcset left and the index of its first listed image.
    fn srcset(&mut self, value: &str, element: Option<Reason>, list: bool) -> Option<(String, Option<usize>)> {
        let candidates = trackers::srcset(value);
        let before = candidates.len();
        let mut first = None;
        let mut kept = Vec::new();
        for candidate in candidates {
            let Some(url) = trackers::remote(candidate.url) else {
                kept.push(candidate);
                continue;
            };
            let reason = trackers::by_url(&url).or(element);
            if reason.is_none() && !list {
                continue;
            }
            if let Verdict::Place(index) = self.sort(&url, reason) {
                first.get_or_insert(index);
            }
        }
        (kept.len() < before).then(|| (trackers::join_srcset(&kept), first))
    }
}

/// Sets a srcset pass 2 kept, or takes the attribute off when nothing is left of it.
fn set_srcset(element: &mut Element<'_, '_>, kept: &str) {
    if kept.is_empty() {
        element.remove_attribute("srcset");
    } else {
        set(element, "srcset", kept);
    }
}

/// The line an `<img>` becomes while its image waits: its alt text, and its size if it had one.
fn placeholder(element: &Element<'_, '_>, index: usize) -> String {
    let alt = attribute(element, "alt").unwrap_or_default();
    let mut line = format!(r#"<span data-letterbox-image="{index}""#);
    for (from, to) in [("width", "data-letterbox-width"), ("height", "data-letterbox-height")] {
        if let Some(value) = attribute(element, from) {
            line.push_str(&format!(
                r#" {to}="{}""#,
                html_escape::encode_double_quoted_attribute(value.trim())
            ));
        }
    }
    line.push('>');
    line.push_str(&html_escape::encode_text(alt.trim()));
    line.push_str("</span>");
    line
}

/// Pass 2: the body a UI shows.
pub(super) fn rewrite(input: &str, boundary: Option<u32>, marker: Option<&str>, found: &mut Found) -> Option<String> {
    let found = &RefCell::new(found);
    let mut ordinal = 0;
    // How many tables are open, so the colour pass knows a table nested in another.
    let tables = Rc::new(Cell::new(0_u32));
    let on_element = element!("*", move |el| {
        ordinal += 1;
        if boundary == Some(ordinal)
            && let Some(marker) = marker
        {
            el.before(marker, ContentType::Html);
        }
        // Hints a browser acts on outside the image policy, every element that embeds a document
        // of its own, whose content (an iframe's `srcdoc`, an object's data) no pass reads and
        // which a browser acts on apart from this document's opt-outs, and scripts (see html.rs).
        let name = el.tag_name();
        let hint = matches!(
            name.as_str(),
            "base" | "link" | "script" | "iframe" | "frame" | "frameset" | "object" | "embed" | "portal" | "applet"
        ) || name == "meta" && el.has_attribute("http-equiv");
        if hint {
            delete(el);
            return Ok(());
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
        if el.has_attribute("background") {
            found.paint.picture();
        }
        if let Some(verdict) = attribute(el, "background").and_then(|value| found.judge(&value)) {
            el.remove_attribute("background");
            if let Verdict::Place(index) = verdict {
                set(el, "data-letterbox-background", &index.to_string());
            }
        }
        let name = el.tag_name();
        let style = attribute(el, "style");
        let on = Painter::background(el, &name, style.as_deref());
        if let Some(css) = style.and_then(|style| found.restyle(&style, on)) {
            set(el, "style", &css);
        }
        found.paint.attributes(el, &name, on);
        if name == "table" {
            found.paint.table(el, tables.get() > 0);
            if let Some(handlers) = el.end_tag_handlers() {
                tables.set(tables.get() + 1);
                let open = Rc::clone(&tables);
                handlers.push(end_tag!(move |_| {
                    open.set(open.get().saturating_sub(1));
                    Ok(())
                }));
            }
        }
        if let Some(loads) = image_attribute(el, &name)
            && let Some(verdict) = attribute(el, loads).and_then(|value| found.judge(&value))
        {
            el.remove_attribute(loads);
            if let Verdict::Place(index) = verdict {
                set(el, "data-letterbox-image", &index.to_string());
            }
        }
        match name.as_str() {
            "img" => image(el, &mut found),
            // An `<img>` in the same `<picture>` loads in its place, so its remote candidates go.
            "source" => {
                if let Some((kept, _)) = attribute(el, "srcset").and_then(|srcset| found.srcset(&srcset, None, false)) {
                    set_srcset(el, &kept);
                }
            }
            _ => {}
        }
        Ok(())
    });
    let mut style = String::new();
    let on_style = text!("style", move |chunk| {
        style.push_str(chunk.as_str());
        if chunk.last_in_text_node() {
            let css = std::mem::take(&mut style);
            let rewritten = found.borrow_mut().restyle(&css, None).unwrap_or(css);
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

/// Pass 2 for one `<img>`. Hidden or tiny, one that names a remote image goes whole, as a
/// tracker. Otherwise each remote URL is judged on its own: a tracker in `src` takes only `src`,
/// and one in `srcset` only its candidate. One whose `src` is remote, or missing, becomes the
/// placeholder line of its first remote image. One whose `src` is local (`data:`, `cid:`)
/// keeps it and loses its remote candidates. One left with no source and no alt text shows
/// nothing, so it goes too.
fn image(el: &mut Element<'_, '_>, found: &mut Found) {
    let (width, height, style) = (attribute(el, "width"), attribute(el, "height"), attribute(el, "style"));
    let element = trackers::by_element(
        width.as_deref(),
        height.as_deref(),
        style.as_deref(),
        el.has_attribute("hidden"),
    );
    let src = attribute(el, "src");
    let remote_src = src.as_deref().and_then(trackers::remote);
    if let Some(reason) = element {
        let srcset = attribute(el, "srcset").unwrap_or_default();
        let candidates = trackers::srcset(&srcset);
        let urls: Vec<url::Url> = remote_src
            .iter()
            .cloned()
            .chain(
                candidates
                    .iter()
                    .filter_map(|candidate| trackers::remote(candidate.url)),
            )
            .collect();
        if !urls.is_empty() {
            for url in &urls {
                found.sort(url, Some(reason));
            }
            delete(el);
            return;
        }
    }
    let from_src = remote_src.map(|url| {
        let reason = trackers::by_url(&url);
        found.sort(&url, reason)
    });
    let local_src = src.is_some() && from_src.is_none();
    let from_srcset = attribute(el, "srcset").and_then(|srcset| found.srcset(&srcset, None, !local_src));
    if let Some((kept, _)) = &from_srcset {
        set_srcset(el, kept);
    }
    let first = match (from_src, &from_srcset) {
        (Some(Verdict::Place(index)), _) => Some(index),
        (_, Some((_, first))) => *first,
        _ => None,
    };
    if let Some(index) = first {
        el.replace(&placeholder(el, index), ContentType::Html);
    } else if matches!(from_src, Some(Verdict::Drop)) {
        el.remove_attribute("src");
        let alt = attribute(el, "alt").unwrap_or_default();
        if !el.has_attribute("srcset") && alt.trim().is_empty() {
            delete(el);
        }
    }
}
