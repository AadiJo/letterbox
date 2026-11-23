//! The colour pass, part of pass 2 (rewrite.rs): it names every color a body sets, so a UI can
//! show it restyled for the dark reader or in the sender's own colors from one stored copy (see
//! `Colors` in crates/protocol/src/body.rs):
//!   - in CSS, inline or in `<style>`, each color of a text, background or border property
//!     becomes `var(<prefix>color-N, <as written>)`, N its index in the palette (`css`) and the
//!     prefix the body's own (`Body::Ready::css_prefix`), which the sender never sees. Only a
//!     declaration in a form the pass reads is wrapped (`css::Reading::Known`): a `var()` makes a
//!     browser check a value only once it computes it, so a wrapped invalid value would hide an
//!     earlier valid one instead of being dropped.
//!   - a color attribute where a browser honours it (`HINTS`) stays, and the element gets
//!     `data-letterbox-bg`, `-text`, `-link`, `-vlink` or `-alink` naming its N. A rule in an
//!     anonymous cascade layer, in the `<style>` that `finish` puts first, applies it, so any
//!     rule of the sender's, in a layer or not, still wins over it as it did over the attribute.
//!
//! Text set beside a background, in the same rule or on the same element, keeps its contrast on
//! the dark value of the background the browser paints there (`css::background`, which follows
//! `!important` and the order within the rule), as a swatch of its own when that changes its value.
//!
//! It writes only colors and `var()`s, never a URL, so nothing it adds can load anything, and
//! html.rs checks the output all the same. It also tells designed mail from a person's plain
//! HTML (`Painted::branded`).

use letterbox_protocol::ColorRole;
use lol_html::html_content::Element;

use super::color::{self, Rgba};
use super::css::{self, Declaration, Reading, role_of};
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
        let declared = style.and_then(|style| css::background(css::style_attribute(style).iter()));
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

    /// The CSS, a style sheet when `sheet` is true and else a style attribute, with each color of
    /// a text, background or border property named where its declaration is in a form the pass
    /// reads (`css::Reading::Known`). Text is read against the background its rule paints
    /// (`css::background`), else against `on`, the element's own for a style attribute. None
    /// when it names none.
    pub fn css(&mut self, css: &str, on: Option<Rgba>, sheet: bool) -> Option<String> {
        let found = if sheet {
            css::style_sheet(css)
        } else {
            css::style_attribute(css)
        };
        let mut rules: HashMap<usize, Vec<&Declaration>> = HashMap::default();
        for declaration in &found {
            rules.entry(declaration.rule).or_default().push(declaration);
        }
        let backgrounds: HashMap<usize, Option<Option<Rgba>>> = rules
            .into_iter()
            .map(|(rule, declared)| (rule, css::background(declared.into_iter())))
            .collect();
        let mut changes = Vec::new();
        for declaration in &found {
            let Some(role) = role_of(&declaration.name) else {
                continue;
            };
            let value = &css[declaration.value.clone()];
            if role == ColorRole::Background
                && (["url(", "image-set(", "gradient("]
                    .iter()
                    .any(|image| value.to_ascii_lowercase().contains(image))
                    || value.contains(&format!("var({}image-", self.prefix)))
            {
                self.designed = true;
            }
            let Reading::Known { colors, .. } = &declaration.reading else {
                continue;
            };
            let beside = backgrounds.get(&declaration.rule).copied().flatten().unwrap_or(on);
            for (range, color) in colors {
                if let Some(index) = self.place(role, *color, beside) {
                    let written = &css[range.clone()];
                    changes.push((
                        range.start,
                        range.end,
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

/// True when a color has a clear hue: its channels spread by more than a fifth.
fn hued(color: Rgba) -> bool {
    let channels = [color.r, color.g, color.b];
    let (high, low) = (channels.iter().max(), channels.iter().min());
    high.zip(low).is_some_and(|(high, low)| high - low > 51)
}
