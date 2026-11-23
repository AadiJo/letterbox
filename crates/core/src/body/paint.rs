//! The colour pass, part of pass 2 (rewrite.rs): it names every color a body sets, so a UI can
//! show it restyled for the dark reader or in the sender's own colors from one stored copy (see
//! `Colors` in crates/protocol/src/body.rs):
//!   - in CSS, inline or in `<style>`, each color of a text, background or border property
//!     becomes `var(<prefix>color-N, <as written>)`, N its index in the palette (`css`) and the
//!     prefix the body's own (`Body::Ready::css_prefix`), which the sender never sees. A
//!     color longhand is wrapped only when its value is colors the pass reads and nothing else
//!     (`wrappable`): a `var()` makes a browser check a value only once it computes it, so a
//!     wrapped invalid value would hide an earlier valid one instead of being dropped.
//!   - a color attribute where a browser honours it (`HINTS`) stays, and the element gets
//!     `data-letterbox-bg`, `-text`, `-link`, `-vlink` or `-alink` naming its N. A rule in an
//!     anonymous cascade layer, in the `<style>` that `finish` puts first, applies it, so any
//!     rule of the sender's, in a layer or not, still wins over it as it did over the attribute.
//!
//! Text set beside a background, in the same rule or on the same element, keeps its contrast on
//! that background's dark value (dark.rs), as a swatch of its own when that changes its value.
//!
//! It writes only colors and `var()`s, never a URL, so nothing it adds can load anything, and
//! html.rs checks the output all the same. It also tells designed mail from a person's plain
//! HTML (`Painted::branded`).

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
    /// The start of the custom property names it writes (see `Body::Ready::css_prefix`).
    prefix: String,
    palette: Vec<Swatch>,
    /// Each swatch's index by role, color and, for text, the background set beside it.
    places: HashMap<(ColorRole, Rgba, Option<Rgba>), usize>,
    /// Each swatch's index by role, color and dark value, so text whose background leaves its
    /// dark value as it is shares one swatch.
    values: HashMap<(ColorRole, Rgba, Rgba), usize>,
    /// The rules that apply color attributes, each once, in the order they were met.
    rules: Vec<String>,
    ruled: HashSet<(&'static str, usize)>,
    /// A background image or gradient, or a layout table, was seen.
    designed: bool,
}

/// A color attribute a browser honours, as the HTML standard's rendering section lists them.
struct Hint {
    attribute: &'static str,
    /// The elements it is honoured on.
    on: &'static [&'static str],
    role: ColorRole,
    /// The element's `data-letterbox-` name for it.
    data: &'static str,
    /// What the rule colors, after the element's selector: the element itself (`""`) or links in it.
    targets: &'static [&'static str],
    property: &'static str,
}

const HINTS: [Hint; 6] = [
    Hint {
        attribute: "bgcolor",
        on: &["body", "table", "thead", "tbody", "tfoot", "tr", "td", "th"],
        role: ColorRole::Background,
        data: "bg",
        targets: &[""],
        property: "background-color",
    },
    Hint {
        attribute: "color",
        on: &["font"],
        role: ColorRole::Text,
        data: "text",
        targets: &[""],
        property: "color",
    },
    Hint {
        attribute: "text",
        on: &["body"],
        role: ColorRole::Text,
        data: "text",
        targets: &[""],
        property: "color",
    },
    Hint {
        attribute: "link",
        on: &["body"],
        role: ColorRole::Text,
        data: "link",
        targets: &[" :link"],
        property: "color",
    },
    Hint {
        attribute: "vlink",
        on: &["body"],
        role: ColorRole::Text,
        data: "vlink",
        targets: &[" :visited"],
        property: "color",
    },
    Hint {
        attribute: "alink",
        on: &["body"],
        role: ColorRole::Text,
        data: "alink",
        targets: &[" :link:active", " :visited:active"],
        property: "color",
    },
];

/// The background color a background declaration sets: Some(None) when it sets none or more
/// than one (an image or a gradient), None when the property sets no background.
fn background_in(name: &str, value: &str) -> Option<Option<Rgba>> {
    if !matches!(name, "background" | "background-color") {
        return None;
    }
    match colors_in(value).as_slice() {
        [(_, _, color)] if color.a > 0 => Some(Some(*color)),
        _ => Some(None),
    }
}

impl Painter {
    /// A pass that names its custom properties with `prefix`.
    pub fn with_prefix(prefix: &str) -> Painter {
        Painter {
            prefix: prefix.to_owned(),
            ..Painter::default()
        }
    }

    /// The palette index of a color in a role, on a background for text, added at first sight.
    /// None for a color with no alpha, which shows nothing either way (hidden text stays
    /// hidden), or past MAX_SWATCHES.
    fn place(&mut self, role: ColorRole, color: Rgba, on: Option<Rgba>) -> Option<usize> {
        if color.a == 0 {
            return None;
        }
        let on = on.filter(|_| role == ColorRole::Text);
        if let Some(index) = self.places.get(&(role, color, on)) {
            return Some(*index);
        }
        let value = dark(role, color, on);
        if let Some(index) = self.values.get(&(role, color, value)).copied() {
            self.places.insert((role, color, on), index);
            return Some(index);
        }
        if self.palette.len() >= MAX_SWATCHES {
            self.designed = true;
            return None;
        }
        let index = self.palette.len();
        self.places.insert((role, color, on), index);
        self.values.insert((role, color, value), index);
        self.palette.push((role, color, value));
        Some(index)
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

    /// The background an element sets for itself, which the text it sets is read against: its
    /// style's, else its `bgcolor` where a browser honours one. Pass 2 asks before it rewrites
    /// the element's style (`css`) and attributes (`attributes`).
    pub fn background(element: &Element<'_, '_>, name: &str, style: Option<&str>) -> Option<Rgba> {
        let declared = style.and_then(|css| {
            let found = declarations(css);
            found
                .iter()
                .rev()
                .find_map(|(property, start, end, _)| background_in(property, &css[*start..*end]))
        });
        declared.unwrap_or_else(|| {
            let honoured = HINTS[0].on.contains(&name);
            honoured
                .then(|| attribute(element, "bgcolor").and_then(|value| color::legacy(&value)))
                .flatten()
        })
    }

    /// Names each color attribute `element` carries where a browser honours it (see the module
    /// docs). Text is read against `on`, the element's own background (`background`).
    pub fn attributes(&mut self, element: &mut Element<'_, '_>, name: &str, on: Option<Rgba>) {
        for hint in &HINTS {
            if !hint.on.contains(&name) {
                continue;
            }
            let Some(color) = attribute(element, hint.attribute).and_then(|value| color::legacy(&value)) else {
                continue;
            };
            let Some(index) = self.place(hint.role, color, on) else {
                continue;
            };
            let data = hint.data;
            set(element, &format!("data-letterbox-{data}"), &index.to_string());
            if self.ruled.insert((data, index)) {
                let selectors: Vec<String> = hint
                    .targets
                    .iter()
                    .map(|target| format!(r#"[data-letterbox-{data}="{index}"]{target}"#))
                    .collect();
                self.rules.push(format!(
                    ":where({}){{{}:var({}color-{index}, {})}}",
                    selectors.join(", "),
                    hint.property,
                    self.prefix,
                    color.hex()
                ));
            }
        }
    }

    /// The CSS with each color of a text, background or border property named (see the module
    /// docs). Takes CSS that `own` has read. Text is read against the background set in its
    /// rule, else against `on`, the element's own for a style attribute. None when it names none.
    pub fn css(&mut self, css: &str, on: Option<Rgba>) -> Option<String> {
        let found = declarations(css);
        let mut backgrounds: HashMap<usize, Option<Rgba>> = HashMap::default();
        for (name, start, end, block) in &found {
            if let Some(background) = background_in(name, &css[*start..*end]) {
                backgrounds.insert(*block, background);
            }
        }
        let mut changes = Vec::new();
        for (name, start, end, block) in &found {
            let value = &css[*start..*end];
            let Some(role) = role_of(name) else { continue };
            if role == ColorRole::Background
                && (["url(", "image-set(", "gradient("]
                    .iter()
                    .any(|image| value.to_ascii_lowercase().contains(image))
                    || value.contains(&format!("var({}image-", self.prefix)))
            {
                self.designed = true;
            }
            let colors = colors_in(value);
            if !wrappable(name, value, &colors) {
                continue;
            }
            let beside = backgrounds.get(block).copied().unwrap_or(on);
            for (from, to, color) in colors {
                if let Some(index) = self.place(role, color, beside) {
                    let written = &value[from..to];
                    changes.push((
                        start + from,
                        start + to,
                        format!("var({}color-{index}, {written})", self.prefix),
                    ));
                }
            }
        }
        (!changes.is_empty()).then(|| super::trackers::replace(css, &changes))
    }

    /// The palette, whether the body is branded, and the `<style>` that applies the color
    /// attributes, which goes at the very start of the HTML (empty when it has none). Its rules
    /// sit in an anonymous layer, which ranks below every other author rule.
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
            format!("<style>@layer{{{}}}</style>", self.rules.concat())
        };
        let painted = Painted {
            palette: self.palette,
            branded,
        };
        (painted, style)
    }
}

/// True when the pass may wrap the colors of a declaration. A shorthand's other parts it does
/// not read, so it wraps them as they come. A color longhand (`color`, `*-color`) only when its
/// value is colors the pass reads, one or up to four for `border-color`, and at most
/// `!important`: anything else a browser may drop as invalid, which it must still do once
/// wrapped. A value that already reads a `var()` a browser checks only as it computes it anyway.
fn wrappable(name: &str, value: &str, colors: &[(usize, usize, Rgba)]) -> bool {
    if !(name == "color" || name.ends_with("-color")) || value.to_ascii_lowercase().contains("var(") {
        return true;
    }
    let most = if name == "border-color" { 4 } else { 1 };
    let mut rest = String::new();
    let mut from = 0;
    for (start, end, _) in colors {
        rest.push_str(&value[from..*start]);
        rest.push(' ');
        from = *end;
    }
    rest.push_str(&value[from..]);
    let rest = rest.trim();
    let flag = rest
        .strip_prefix('!')
        .is_some_and(|flag| flag.trim().eq_ignore_ascii_case("important"));
    (1..=most).contains(&colors.len()) && (rest.is_empty() || flag)
}

/// True when a color has a clear hue: its channels spread by more than a fifth.
fn hued(color: Rgba) -> bool {
    let channels = [color.r, color.g, color.b];
    let (high, low) = (channels.iter().max(), channels.iter().min());
    high.zip(low).is_some_and(|(high, low)| high - low > 51)
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

/// Every declaration in a style attribute or a `<style>` block: its property in lowercase, where
/// its value starts and ends, and which block it is in (one per pair of braces, so declarations
/// with the same number share a rule). A selector with a colon (`a:hover {`) reads at first like a
/// declaration; its `{` shows it is not, and the reading goes on inside the block. At-rules and
/// other selectors are passed over up to their `{` or `;`.
fn declarations(css: &str) -> Vec<(String, usize, usize, usize)> {
    let bytes = css.as_bytes();
    let mut found = Vec::new();
    let mut at = 0;
    // Which block a declaration is in: a count of the braces passed.
    let mut block = 0;
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
                found.push((name.to_ascii_lowercase(), start, end, block));
            }
            at = end;
        } else {
            at = until(bytes, at, b";{}");
        }
        block += usize::from(matches!(bytes.get(at), Some(b'{' | b'}')));
        at += 1;
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
