//! The colour pass, part of pass 2 (rewrite.rs): it names every color a body sets, so a UI can
//! show it restyled for the dark reader or in the sender's own colors from one stored copy (see
//! `Colors` in crates/protocol/src/body.rs):
//!   - in CSS, inline or in `<style>`, each color of a text, background or border property
//!     becomes `var(--letterbox-color-N, <as written>)`, N its index in the palette (`css`),
//!   - a color attribute (`bgcolor`, `<font color>`, `<body text>` and `link`) stays, and the
//!     element gets `data-letterbox-bg`, `-text` or `-link` naming its N, which a zero-specificity
//!     rule in the `<style>` that `finish` writes applies, as the attribute did (`attributes`),
//!   - a custom property the sender named `--letterbox-…` is renamed (`own`), so a sender cannot
//!     set the core's own.
//!
//! It writes only colors and `var()`s, never a URL, so nothing it adds can load anything, and
//! html.rs checks the output all the same. It also tells designed mail from a person's plain
//! HTML (`Painted::branded`).

use std::borrow::Cow;

use letterbox_protocol::ColorRole;
use lol_html::html_content::Element;

use super::color::{self, Rgba};
use super::dark::dark;
use super::html::{attribute, set};
use crate::maps::{HashMap, HashSet};

/// The most colors a palette names. Past it, a color keeps its own value in both schemes.
const MAX_SWATCHES: usize = 256;

/// How many colors with a clear hue (see `hued`) make a body branded.
const MANY_HUES: usize = 3;

/// One palette entry: the color, its role and its dark value.
pub type Swatch = (ColorRole, Rgba, Rgba);

/// What the colour pass found in one body.
pub struct Painted {
    pub palette: Vec<Swatch>,
    /// Designed mail: background images or gradients, layout tables, or many colors.
    pub branded: bool,
}

/// The colour pass's state across one body's elements and style blocks.
#[derive(Default)]
pub struct Painter {
    palette: Vec<Swatch>,
    places: HashMap<(ColorRole, Rgba), usize>,
    /// The rules that apply color attributes, each once, in the order they were met.
    rules: Vec<String>,
    ruled: HashSet<(&'static str, usize)>,
    /// A background image or gradient, or a layout table, was seen.
    designed: bool,
}

/// The color attributes, by element: the attribute, the role its color plays, the
/// `data-letterbox-` name the element gets, and the rule's selector and property.
const ATTRIBUTES: [(&str, Option<&str>, ColorRole, &str, &str); 4] = [
    ("bgcolor", None, ColorRole::Background, "bg", "background-color"),
    ("color", Some("font"), ColorRole::Text, "text", "color"),
    ("text", Some("body"), ColorRole::Text, "text", "color"),
    ("link", Some("body"), ColorRole::Text, "link", "color"),
];

impl Painter {
    /// The palette index of a color in a role, added at first sight. None for a color with no
    /// alpha, which shows nothing either way (hidden text stays hidden), or past MAX_SWATCHES.
    fn place(&mut self, role: ColorRole, color: Rgba) -> Option<usize> {
        if color.a == 0 {
            return None;
        }
        if let Some(index) = self.places.get(&(role, color)) {
            return Some(*index);
        }
        if self.palette.len() >= MAX_SWATCHES {
            self.designed = true;
            return None;
        }
        self.places.insert((role, color), self.palette.len());
        self.palette.push((role, color, dark(role, color)));
        Some(self.palette.len() - 1)
    }

    /// Notes a table: one inside another, or marked as presentation, lays out designed mail.
    pub fn table(&mut self, element: &Element<'_, '_>, nested: bool) {
        let role = attribute(element, "role").unwrap_or_default();
        let presentation = ["presentation", "none"].contains(&role.trim().to_ascii_lowercase().as_str());
        self.designed |= nested || presentation;
    }

    /// Notes a `background` attribute, an image behind designed mail.
    pub fn picture(&mut self) {
        self.designed = true;
    }

    /// Names each color attribute `element` carries (see the module docs).
    pub fn attributes(&mut self, element: &mut Element<'_, '_>, name: &str) {
        for (attribute_name, on, role, data, property) in ATTRIBUTES {
            if on.is_some_and(|on| on != name) {
                continue;
            }
            let Some(color) = attribute(element, attribute_name).and_then(|value| color::legacy(&value)) else {
                continue;
            };
            let Some(index) = self.place(role, color) else {
                continue;
            };
            set(element, &format!("data-letterbox-{data}"), &index.to_string());
            if self.ruled.insert((data, index)) {
                let target = format!(r#"[data-letterbox-{data}="{index}"]"#);
                let selector = if data == "link" {
                    format!("{target} :link")
                } else {
                    target
                };
                self.rules.push(format!(
                    ":where({selector}){{{property}:var(--letterbox-color-{index}, {})}}",
                    color.hex()
                ));
            }
        }
    }

    /// The CSS with each color of a text, background or border property named (see the module
    /// docs). Takes CSS that `own` has read. None when it names none.
    pub fn css(&mut self, css: &str) -> Option<String> {
        let mut changes = Vec::new();
        for (name, start, end) in declarations(css) {
            let value = &css[start..end];
            let Some(role) = role_of(&name) else { continue };
            if role == ColorRole::Background
                && ["url(", "var(--letterbox-image-", "image-set(", "gradient("]
                    .iter()
                    .any(|image| value.to_ascii_lowercase().contains(image))
            {
                self.designed = true;
            }
            for (from, to, color) in colors_in(value) {
                if let Some(index) = self.place(role, color) {
                    let written = &value[from..to];
                    changes.push((
                        start + from,
                        start + to,
                        format!("var(--letterbox-color-{index}, {written})"),
                    ));
                }
            }
        }
        (!changes.is_empty()).then(|| super::trackers::replace(css, &changes))
    }

    /// The palette, whether the body is branded, and the `<style>` that applies the color
    /// attributes, which goes at the very start of the HTML (empty when it has none).
    pub fn finish(self) -> (Painted, String) {
        let hues = {
            let mut hues: Vec<Rgba> = self
                .palette
                .iter()
                .filter(|(_, color, _)| hued(*color))
                .map(|(_, color, _)| *color)
                .collect();
            hues.sort_unstable_by_key(|color| (color.r, color.g, color.b, color.a));
            hues.dedup();
            hues.len()
        };
        let branded = self.designed || hues >= MANY_HUES;
        let style = if self.rules.is_empty() {
            String::new()
        } else {
            format!("<style>{}</style>", self.rules.concat())
        };
        let painted = Painted {
            palette: self.palette,
            branded,
        };
        (painted, style)
    }
}

/// True when a color has a clear hue: its channels spread by more than a fifth.
fn hued(color: Rgba) -> bool {
    let channels = [color.r, color.g, color.b];
    let (high, low) = (channels.iter().max(), channels.iter().min());
    high.zip(low).is_some_and(|(high, low)| high - low > 51)
}

/// CSS with every custom property the sender named `--letterbox-…`, declared or read, renamed
/// `--sender-letterbox-…`, so only the core's own reach the frame by that name.
pub fn own(css: &str) -> Cow<'_, str> {
    if css.contains("--letterbox-") {
        Cow::Owned(css.replace("--letterbox-", "--sender-letterbox-"))
    } else {
        Cow::Borrowed(css)
    }
}

/// The role a property's colors play. None for a property whose colors the pass leaves.
fn role_of(name: &str) -> Option<ColorRole> {
    match name {
        "color" | "text-decoration" | "text-decoration-color" | "-webkit-text-fill-color" => Some(ColorRole::Text),
        "background" | "background-color" | "background-image" => Some(ColorRole::Background),
        _ if name.starts_with("border") || name.starts_with("outline") => Some(ColorRole::Border),
        _ => None,
    }
}

/// Where a run of CSS ends: the index of the first `stops` byte outside strings, comments and
/// brackets, from `at`, or the end.
fn until(css: &[u8], mut at: usize, stops: &[u8]) -> usize {
    let mut depth = 0_u32;
    while at < css.len() {
        match css[at] {
            quote @ (b'"' | b'\'') => at = string_end(css, at, quote),
            b'/' if css.get(at + 1) == Some(&b'*') => at = comment_end(css, at),
            byte if depth == 0 && stops.contains(&byte) => return at,
            b'(' | b'[' => {
                depth += 1;
                at += 1;
            }
            b')' | b']' => {
                depth = depth.saturating_sub(1);
                at += 1;
            }
            _ => at += 1,
        }
    }
    css.len()
}

/// Just past the string that opens at `at`.
fn string_end(css: &[u8], at: usize, quote: u8) -> usize {
    let mut index = at + 1;
    while index < css.len() && css[index] != quote {
        index += if css[index] == b'\\' { 2 } else { 1 };
    }
    (index + 1).min(css.len())
}

/// Just past the comment that opens at `at`.
fn comment_end(css: &[u8], at: usize) -> usize {
    let rest = &css[at + 2..];
    rest.windows(2)
        .position(|pair| pair == b"*/")
        .map_or(css.len(), |offset| at + 2 + offset + 2)
}

/// True for a byte that can be part of a CSS name. Bytes past ASCII belong to names too.
fn name_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_') || byte >= 0x80
}

/// Every declaration in a style attribute or a `<style>` block: its property in lowercase and
/// where its value starts and ends. A selector with a colon (`a:hover {`) reads at first like a
/// declaration; its `{` shows it is not, and the reading goes on inside the block. At-rules and
/// other selectors are passed over up to their `{` or `;`.
fn declarations(css: &str) -> Vec<(String, usize, usize)> {
    let bytes = css.as_bytes();
    let mut found = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        while at < bytes.len() && (bytes[at].is_ascii_whitespace() || bytes[at] == b';') {
            at += 1;
        }
        if bytes[at..].starts_with(b"/*") {
            at = comment_end(bytes, at);
            continue;
        }
        let name_start = at;
        while at < bytes.len() && name_byte(bytes[at]) {
            at += 1;
        }
        let name = &css[name_start..at];
        while at < bytes.len() && bytes[at].is_ascii_whitespace() {
            at += 1;
        }
        if !name.is_empty() && bytes.get(at) == Some(&b':') {
            let start = at + 1;
            let end = until(bytes, start, b";{}");
            if bytes.get(end) != Some(&b'{') {
                found.push((name.to_ascii_lowercase(), start, end));
            }
            at = end + 1;
        } else {
            at = until(bytes, at, b";{}") + 1;
        }
    }
    found
}

/// Every color in a declaration's value: where it starts and ends, and what it is. Strings,
/// comments and `url()`s are passed over, and so is any name that starts with `--`.
fn colors_in(value: &str) -> Vec<(usize, usize, Rgba)> {
    let bytes = value.as_bytes();
    let mut found = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        match bytes[at] {
            quote @ (b'"' | b'\'') => at = string_end(bytes, at, quote),
            b'/' if bytes.get(at + 1) == Some(&b'*') => at = comment_end(bytes, at),
            b'#' => {
                let end = at + 1 + bytes[at + 1..].iter().take_while(|byte| name_byte(**byte)).count();
                if let Some(color) = color::color_of(&value[at..end]) {
                    found.push((at, end, color));
                }
                at = end;
            }
            byte if name_byte(byte) && !byte.is_ascii_digit() => {
                let start = at;
                while at < bytes.len() && name_byte(bytes[at]) {
                    at += 1;
                }
                let name = &value[start..at];
                if bytes.get(at) != Some(&b'(') {
                    if !name.starts_with("--")
                        && let Some(color) = color::named(name)
                    {
                        found.push((start, at, color));
                    }
                    continue;
                }
                let function = name.to_ascii_lowercase();
                if matches!(function.as_str(), "url" | "rgb" | "rgba" | "hsl" | "hsla") {
                    let end = (until(bytes, at + 1, b")") + 1).min(bytes.len());
                    if function != "url"
                        && let Some(color) = color::color_of(&value[start..end])
                    {
                        found.push((start, end, color));
                    }
                    at = end;
                } else {
                    at += 1;
                }
            }
            byte if byte.is_ascii_digit() => {
                while at < bytes.len() && name_byte(bytes[at]) {
                    at += 1;
                }
            }
            _ => at += 1,
        }
    }
    found
}
