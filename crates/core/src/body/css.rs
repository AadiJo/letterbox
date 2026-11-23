//! CSS as the colour pass reads it (paint.rs): its declarations and the colors in them, and
//! which declarations it may wrap and which background a rule paints. CSS is read with its own
//! syntax's whitespace, strings, comments and brackets, never with patterns, and the pass reads
//! only the forms below: anything else it leaves as written, since a value it wrapped in a
//! `var()` would no longer be dropped by a browser as invalid, and would hide the valid
//! declaration before it.

use letterbox_protocol::ColorRole;

use super::color::{self, Rgba, css_number, css_trim};

/// One declaration's value as the pass reads it.
pub struct Read {
    /// Each color in it: where it starts and ends, and what it is (`colors_in`).
    pub colors: Vec<(usize, usize, Rgba)>,
    /// Its other words, in order, without a final `!important`. None when it holds a `!` that is
    /// not that, or a comment: forms the pass does not read.
    words: Option<Vec<String>>,
    pub important: bool,
    /// It calls `var()`, outside strings and comments: a browser checks it only as it computes it.
    var: bool,
}

/// Reads one declaration's value.
pub fn read(value: &str) -> Read {
    let colors = colors_in(value);
    let mut rest = String::new();
    let mut from = 0;
    for (start, end, _) in &colors {
        rest.push_str(&value[from..*start]);
        rest.push(' ');
        from = *end;
    }
    rest.push_str(&value[from..]);
    let rest = css_trim(&rest);
    let (rest, important) = match rest.rfind('!') {
        Some(at) if css_trim(&rest[at + 1..]).eq_ignore_ascii_case("important") => (css_trim(&rest[..at]), true),
        _ => (rest, false),
    };
    let readable = !rest.contains('!') && !rest.contains("/*");
    Read {
        words: readable.then(|| rest.split_ascii_whitespace().map(str::to_owned).collect()),
        important,
        var: reads_var(value),
        colors,
    }
}

/// True when CSS calls `var()`: the name `var`, in any case, right before `(`, outside strings
/// and comments and not the end of a longer name.
fn reads_var(value: &str) -> bool {
    let bytes = value.as_bytes();
    let mut at = 0;
    while at < bytes.len() {
        match bytes[at] {
            quote @ (b'"' | b'\'') => at = string_end(bytes, at, quote),
            b'/' if bytes.get(at + 1) == Some(&b'*') => at = comment_end(bytes, at),
            byte if name_byte(byte) => {
                let start = at;
                while at < bytes.len() && name_byte(bytes[at]) {
                    at += 1;
                }
                if value[start..at].eq_ignore_ascii_case("var") && bytes.get(at) == Some(&b'(') {
                    return true;
                }
            }
            _ => at += 1,
        }
    }
    false
}

/// The shorthands for one or more borders, and `outline`.
const LINES: [&str; 12] = [
    "border",
    "border-top",
    "border-right",
    "border-bottom",
    "border-left",
    "border-block",
    "border-inline",
    "border-block-start",
    "border-block-end",
    "border-inline-start",
    "border-inline-end",
    "outline",
];

/// True when the pass may wrap a declaration's colors: it is in a form a browser keeps, so the
/// wrapped value paints what the sender's did. Those forms are:
///   - `background`, `color` or a `*-color` longhand: one color and nothing else,
///   - `border-color`: one to four colors,
///   - a border shorthand or `outline`: one color, with at most one width and one style,
///   - `text-decoration`: one color, with line keywords (`underline`, `overline`,
///     `line-through`, `blink`, each once) or `none`,
///
/// each with an optional `!important`. A value that calls `var()` a browser checks only as it
/// computes it, wrapped or not, so its colors may be wrapped too.
pub fn wrappable(name: &str, read: &Read) -> bool {
    if read.var {
        return true;
    }
    let Some(words) = &read.words else {
        return false;
    };
    let count = read.colors.len();
    match name {
        "border-color" => (1..=4).contains(&count) && words.is_empty(),
        "background" | "color" => count == 1 && words.is_empty(),
        _ if name.ends_with("-color") => count == 1 && words.is_empty(),
        _ if LINES.contains(&name) => count == 1 && line(words, name == "outline"),
        "text-decoration" => count == 1 && decoration(words),
        _ => false,
    }
}

/// True for the words of a border or outline shorthand beside its color: at most one width
/// (`thin`, `medium`, `thick` or a length) and at most one style.
fn line(words: &[String], outline: bool) -> bool {
    let styles = [
        "none", "hidden", "dotted", "dashed", "solid", "double", "groove", "ridge", "inset", "outset",
    ];
    let (mut width, mut style) = (false, false);
    for word in words {
        let word = word.to_ascii_lowercase();
        if ["thin", "medium", "thick"].contains(&word.as_str()) || length(&word) {
            if width {
                return false;
            }
            width = true;
        } else if styles.contains(&word.as_str()) || outline && word == "auto" {
            if style {
                return false;
            }
            style = true;
        } else {
            return false;
        }
    }
    true
}

/// True for a CSS length a border width takes: 0, or a number with a length unit.
fn length(word: &str) -> bool {
    const UNITS: [&str; 15] = [
        "px", "em", "rem", "ex", "ch", "pt", "pc", "cm", "mm", "in", "q", "vw", "vh", "vmin", "vmax",
    ];
    if css_number(word) == Some(0.0) {
        return true;
    }
    UNITS.iter().any(|unit| {
        word.strip_suffix(unit)
            .is_some_and(|number| css_number(number).is_some_and(|value| value >= 0.0))
    })
}

/// True for the words of a `text-decoration` beside its color: `none`, or line keywords, each once.
fn decoration(words: &[String]) -> bool {
    let words: Vec<String> = words.iter().map(|word| word.to_ascii_lowercase()).collect();
    if words == ["none"] {
        return true;
    }
    let lines = ["underline", "overline", "line-through", "blink"];
    words.iter().all(|word| lines.contains(&word.as_str()))
        && words.iter().enumerate().all(|(at, word)| !words[..at].contains(word))
}

/// What a background declaration does to the background color, as far as the pass can tell.
enum Paints {
    Color(Rgba),
    /// No color: `transparent`, or `background: none`.
    Clear,
    /// A form the pass does not read: an image or gradient, a keyword, a `var()`, or a color
    /// space it does not know. It may paint a color or none.
    Unknown,
}

/// What a declaration paints as the background color. None for a declaration of another
/// property, and for one the pass knows a browser drops as invalid: a `background-color` with
/// more than a color, or two.
fn paints(name: &str, read: &Read) -> Option<Paints> {
    if !matches!(name, "background" | "background-color") {
        return None;
    }
    if read.var {
        return Some(Paints::Unknown);
    }
    let Some(words) = &read.words else {
        return Some(Paints::Unknown);
    };
    match (read.colors.as_slice(), words.as_slice()) {
        ([(_, _, color)], []) if color.a > 0 => Some(Paints::Color(*color)),
        ([_], []) => Some(Paints::Clear),
        ([], [word]) if word.eq_ignore_ascii_case("transparent") => Some(Paints::Clear),
        ([], [word]) if name == "background" && word.eq_ignore_ascii_case("none") => Some(Paints::Clear),
        _ if name == "background-color" && !read.colors.is_empty() => None,
        _ => Some(Paints::Unknown),
    }
}

/// The background color one rule, or one style attribute, paints, as the cascade within it
/// decides: the last declaration that a browser keeps wins, an `!important` one over any other,
/// and `background` sets the color as `background-color` does. None when it declares no
/// background. Some(None) when it paints none, or one the pass cannot tell.
pub fn background<'a>(declarations: impl Iterator<Item = (&'a str, &'a str)>) -> Option<Option<Rgba>> {
    let (mut normal, mut important) = (None, None);
    for (name, value) in declarations {
        let read = read(value);
        let Some(painted) = paints(name, &read) else {
            continue;
        };
        if read.important {
            important = Some(painted);
        } else {
            normal = Some(painted);
        }
    }
    important.or(normal).map(|painted| match painted {
        Paints::Color(color) => Some(color),
        Paints::Clear | Paints::Unknown => None,
    })
}

/// The role a property's colors play. None for a property whose colors the pass leaves.
pub fn role_of(name: &str) -> Option<ColorRole> {
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
pub fn declarations(css: &str) -> Vec<(String, usize, usize, usize)> {
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
pub fn colors_in(value: &str) -> Vec<(usize, usize, Rgba)> {
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
