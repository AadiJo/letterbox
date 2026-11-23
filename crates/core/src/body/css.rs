//! CSS as the colour pass reads it (paint.rs). Style attributes and style sheets go through
//! cssparser, the CSS Syntax tokenizer and rule parser of Servo and Firefox, so rules, blocks,
//! strings, comments, hash and function tokens and `!important` are read as a browser reads
//! them, never with patterns.
//!
//! Each declaration's value is classified (`classify`): `Known` when it is exactly one of a few
//! forms the pass reads, every one of them a value a browser keeps, else `Unknown`. The pass
//! wraps only what is known. A value it wrapped in a `var()` would no longer be dropped as
//! invalid, and would hide the valid declaration before it, so anything else stays as written,
//! a `var()` or a keyword like `inherit` too. The same reading decides which background a rule
//! paints (`background`), and it never guesses: when a declaration it cannot read could win,
//! it says it does not know.

use std::ops::Range;

use cssparser::{
    AtRuleParser, CowRcStr, DeclarationParser, ParseError, Parser, ParserInput, ParserState, QualifiedRuleParser,
    RuleBodyItemParser, RuleBodyParser, StyleSheetParser, Token, parse_important,
};
use letterbox_protocol::ColorRole;

use super::color::{self, Rgba, Value};

/// One declaration of a style attribute or a style sheet, as the pass reads it.
pub struct Declaration {
    /// Its property, in lowercase.
    pub name: String,
    /// Which rule it is in: declarations with the same number share a rule.
    pub rule: usize,
    /// Where its value sits in the CSS, in bytes, without `!important`.
    pub value: Range<usize>,
    pub reading: Reading,
}

/// What the pass makes of a declaration's value (`classify`).
pub enum Reading {
    /// One of the forms the pass reads: each color in it, with where it sits in the CSS. A
    /// `transparent` is part of the form but names no color.
    Known {
        colors: Vec<(Range<usize>, Rgba)>,
        important: bool,
    },
    /// Any other value: a browser may keep it or drop it, and the pass cannot tell which.
    Unknown { important: bool },
}

impl Reading {
    fn important(&self) -> bool {
        match self {
            Reading::Known { important, .. } | Reading::Unknown { important } => *important,
        }
    }
}

/// Every declaration of a style attribute, in order.
pub fn style_attribute(css: &str) -> Vec<Declaration> {
    let mut input = ParserInput::new(css);
    let mut parser = Parser::new(&mut input);
    let mut reader = Reader::default();
    for _ in RuleBodyParser::new(&mut parser, &mut reader) {}
    reader.found
}

/// Every declaration of a style sheet, in order, each with its rule: in style rules, nested
/// ones, and the rules inside `@media`, `@supports`, `@layer` and the other group rules.
pub fn style_sheet(css: &str) -> Vec<Declaration> {
    let mut input = ParserInput::new(css);
    let mut parser = Parser::new(&mut input);
    let mut reader = Reader {
        nested: true,
        ..Reader::default()
    };
    for _ in StyleSheetParser::new(&mut parser, &mut reader) {}
    reader.found
}

/// Reads declarations for cssparser's rule and declaration parsers.
#[derive(Default)]
struct Reader {
    found: Vec<Declaration>,
    /// The rule being read, and the last number given out.
    rule: usize,
    rules: usize,
    /// True in a style sheet, whose rules hold rules of their own (CSS nesting).
    nested: bool,
}

impl Reader {
    /// Reads a rule's block as a rule of its own.
    fn rule_block(&mut self, input: &mut Parser<'_, '_>) {
        let outer = self.rule;
        self.rules += 1;
        self.rule = self.rules;
        for _ in RuleBodyParser::new(input, self) {}
        self.rule = outer;
    }
}

/// Passes over a prelude: a selector list, or an at-rule's condition.
fn skip(input: &mut Parser<'_, '_>) {
    while input.next().is_ok() {}
}

impl<'i> DeclarationParser<'i> for Reader {
    type Declaration = ();
    type Error = ();

    fn parse_value<'t>(
        &mut self,
        name: CowRcStr<'i>,
        input: &mut Parser<'i, 't>,
        _start: &ParserState,
    ) -> Result<(), ParseError<'i, ()>> {
        let name = name.to_ascii_lowercase();
        let (value, reading) = classify(&name, input);
        self.found.push(Declaration {
            name,
            rule: self.rule,
            value,
            reading,
        });
        Ok(())
    }
}

impl<'i> QualifiedRuleParser<'i> for Reader {
    type Prelude = ();
    type QualifiedRule = ();
    type Error = ();

    fn parse_prelude<'t>(&mut self, input: &mut Parser<'i, 't>) -> Result<(), ParseError<'i, ()>> {
        skip(input);
        Ok(())
    }

    fn parse_block<'t>(
        &mut self,
        _prelude: (),
        _start: &ParserState,
        input: &mut Parser<'i, 't>,
    ) -> Result<(), ParseError<'i, ()>> {
        self.rule_block(input);
        Ok(())
    }
}

impl<'i> AtRuleParser<'i> for Reader {
    /// True for a group rule, whose block holds rules.
    type Prelude = bool;
    type AtRule = ();
    type Error = ();

    fn parse_prelude<'t>(
        &mut self,
        name: CowRcStr<'i>,
        input: &mut Parser<'i, 't>,
    ) -> Result<bool, ParseError<'i, ()>> {
        skip(input);
        let name = name.to_ascii_lowercase();
        Ok(matches!(
            name.as_str(),
            "media" | "supports" | "layer" | "container" | "scope" | "starting-style" | "document" | "-moz-document"
        ))
    }

    fn rule_without_block(&mut self, _prelude: bool, _start: &ParserState) -> Result<(), ()> {
        Ok(())
    }

    fn parse_block<'t>(
        &mut self,
        group: bool,
        _start: &ParserState,
        input: &mut Parser<'i, 't>,
    ) -> Result<(), ParseError<'i, ()>> {
        // Other at-rules (`@font-face`, `@keyframes`, `@page`) hold descriptors and frames,
        // which the pass leaves as written.
        if group {
            for _ in StyleSheetParser::new(input, self) {}
        }
        Ok(())
    }
}

impl<'i> RuleBodyItemParser<'i, (), ()> for Reader {
    fn parse_declarations(&self) -> bool {
        true
    }

    fn parse_qualified(&self) -> bool {
        self.nested
    }
}

/// One component of a value, as `classify` matches forms on them.
enum Part {
    Color(Range<usize>, Rgba),
    Transparent,
    /// A keyword, in lowercase.
    Word(String),
    /// A border width given as a length: 0, or a number with a length unit.
    Length,
    Other,
}

/// Reads one declaration's value from its delimited parser, and classifies it: `Known` when it
/// is exactly one of these forms, each with an optional `!important`, else `Unknown`:
///   - `background`, `color` or a `*-color` longhand: one color,
///   - `border-color`: one to four colors,
///   - a border shorthand: one color, with at most one width and at most one border style,
///   - `outline`: the same, with outline's own styles (`auto`, and no `hidden`),
///   - `text-decoration`: one color, with line keywords (`underline`, `overline`,
///     `line-through`, `blink`, each once) or `none`.
///
/// A color is a hex color, a named one, `transparent`, or `rgb()`, `rgba()`, `hsl()`, `hsla()`
/// in CSS Color 4's grammar. Returns where the value sits in the CSS, without `!important`.
fn classify(name: &str, input: &mut Parser<'_, '_>) -> (Range<usize>, Reading) {
    let start = input.position().byte_index();
    let mut end = start;
    let mut parts = Vec::new();
    let mut important = false;
    loop {
        if input
            .try_parse(|input| parse_important(input).and_then(|()| input.expect_exhausted()))
            .is_ok()
        {
            important = true;
            break;
        }
        let at = input.position().byte_index();
        let Ok(token) = input.next_including_whitespace_and_comments().cloned() else {
            break;
        };
        let part = match token {
            Token::WhiteSpace(_) | Token::Comment(_) => continue,
            Token::Hash(digits) | Token::IDHash(digits) => {
                color::hex(&digits).map_or(Part::Other, |rgba| Part::Color(at..input.position().byte_index(), rgba))
            }
            Token::Ident(word) if word.eq_ignore_ascii_case("transparent") => Part::Transparent,
            Token::Ident(word) => match color::named(&word) {
                Some(rgba) => Part::Color(at..input.position().byte_index(), rgba),
                None => Part::Word(word.to_ascii_lowercase()),
            },
            Token::Function(function) => {
                let function = function.to_ascii_lowercase();
                let read =
                    input.parse_nested_block(|block| Ok::<_, ParseError<'_, ()>>(function_color(&function, block)));
                match read.ok().flatten() {
                    Some(rgba) => Part::Color(at..input.position().byte_index(), rgba),
                    None => Part::Other,
                }
            }
            Token::ParenthesisBlock | Token::SquareBracketBlock | Token::CurlyBracketBlock => {
                let _ = input.parse_nested_block(|block| {
                    skip(block);
                    Ok::<_, ParseError<'_, ()>>(())
                });
                Part::Other
            }
            Token::Number { value: 0.0, .. } => Part::Length,
            Token::Dimension { value, unit, .. } if value >= 0.0 && length_unit(&unit) => Part::Length,
            _ => Part::Other,
        };
        parts.push(part);
        end = input.position().byte_index();
    }
    let known = form(name, &parts);
    let reading = if known {
        let colors = parts
            .into_iter()
            .filter_map(|part| match part {
                Part::Color(range, rgba) => Some((range, rgba)),
                _ => None,
            })
            .collect();
        Reading::Known { colors, important }
    } else {
        Reading::Unknown { important }
    };
    (start..end, reading)
}

/// A color function's color, from the tokens in its parentheses: three values separated by
/// commas with an optional alpha after a fourth (the legacy form), or three separated by space
/// with an optional alpha after a slash. None for anything else, `none` included.
fn function_color(function: &str, block: &mut Parser<'_, '_>) -> Option<Rgba> {
    enum Arg {
        Value(Value),
        Comma,
        Slash,
    }
    let mut args = Vec::new();
    while let Ok(token) = block.next() {
        args.push(match token {
            Token::Number { value, .. } => Arg::Value(Value::Number(f64::from(*value))),
            Token::Percentage { unit_value, .. } => Arg::Value(Value::Percent(f64::from(*unit_value) * 100.0)),
            Token::Dimension { value, unit, .. } => Arg::Value(Value::Angle(angle(f64::from(*value), unit)?)),
            Token::Comma => Arg::Comma,
            Token::Delim('/') => Arg::Slash,
            _ => return None,
        });
    }
    let (values, alpha, legacy) = match args.as_slice() {
        [Arg::Value(a), Arg::Comma, Arg::Value(b), Arg::Comma, Arg::Value(c)] => ([*a, *b, *c], None, true),
        [
            Arg::Value(a),
            Arg::Comma,
            Arg::Value(b),
            Arg::Comma,
            Arg::Value(c),
            Arg::Comma,
            Arg::Value(alpha),
        ] => ([*a, *b, *c], Some(*alpha), true),
        [Arg::Value(a), Arg::Value(b), Arg::Value(c)] => ([*a, *b, *c], None, false),
        [
            Arg::Value(a),
            Arg::Value(b),
            Arg::Value(c),
            Arg::Slash,
            Arg::Value(alpha),
        ] => ([*a, *b, *c], Some(*alpha), false),
        _ => return None,
    };
    match function {
        "rgb" | "rgba" => color::rgb(values, alpha, legacy),
        "hsl" | "hsla" => color::hsl(values, alpha, legacy),
        _ => None,
    }
}

/// An angle in degrees, from a number and its unit: `deg`, `grad`, `rad` or `turn`.
fn angle(value: f64, unit: &str) -> Option<f64> {
    let scale = match unit.to_ascii_lowercase().as_str() {
        "deg" => 1.0,
        "grad" => 0.9,
        "rad" => 180.0 / std::f64::consts::PI,
        "turn" => 360.0,
        _ => return None,
    };
    Some(value * scale)
}

/// True for a unit a length takes, which a border width can be.
fn length_unit(unit: &str) -> bool {
    const UNITS: [&str; 15] = [
        "px", "em", "rem", "ex", "ch", "pt", "pc", "cm", "mm", "in", "q", "vw", "vh", "vmin", "vmax",
    ];
    UNITS.contains(&unit.to_ascii_lowercase().as_str())
}

/// The shorthands for one or more borders.
const BORDERS: [&str; 11] = [
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
];

/// The styles a border takes, and those an outline takes.
const BORDER_STYLES: [&str; 10] = [
    "none", "hidden", "dotted", "dashed", "solid", "double", "groove", "ridge", "inset", "outset",
];
const OUTLINE_STYLES: [&str; 10] = [
    "auto", "none", "dotted", "dashed", "solid", "double", "groove", "ridge", "inset", "outset",
];

/// True when a value's parts are one of `classify`'s forms for the property.
fn form(name: &str, parts: &[Part]) -> bool {
    let colors = parts
        .iter()
        .filter(|part| matches!(part, Part::Color(..) | Part::Transparent))
        .count();
    let only_colors = colors == parts.len();
    match name {
        "border-color" => only_colors && (1..=4).contains(&colors),
        "background" | "color" => only_colors && colors == 1,
        _ if name.ends_with("-color") => only_colors && colors == 1,
        _ if BORDERS.contains(&name) => colors == 1 && line(parts, &BORDER_STYLES),
        "outline" => colors == 1 && line(parts, &OUTLINE_STYLES),
        "text-decoration" => colors == 1 && decoration(parts),
        _ => false,
    }
}

/// True for the parts of a border or outline shorthand beside its color: at most one width
/// (`thin`, `medium`, `thick` or a length) and at most one of `styles`.
fn line(parts: &[Part], styles: &[&str]) -> bool {
    let (mut widths, mut styled) = (0, 0);
    for part in parts {
        match part {
            Part::Color(..) | Part::Transparent => {}
            Part::Length => widths += 1,
            Part::Word(word) if ["thin", "medium", "thick"].contains(&word.as_str()) => widths += 1,
            Part::Word(word) if styles.contains(&word.as_str()) => styled += 1,
            Part::Word(_) | Part::Other => return false,
        }
    }
    widths <= 1 && styled <= 1
}

/// True for the parts of a `text-decoration` beside its color: `none`, or line keywords, each once.
fn decoration(parts: &[Part]) -> bool {
    let words: Vec<&str> = parts
        .iter()
        .filter_map(|part| match part {
            Part::Word(word) => Some(word.as_str()),
            _ => None,
        })
        .collect();
    let others = parts.iter().any(|part| matches!(part, Part::Length | Part::Other));
    if others {
        return false;
    }
    if words == ["none"] {
        return true;
    }
    let lines = ["underline", "overline", "line-through", "blink"];
    words.iter().all(|word| lines.contains(word))
        && words.iter().enumerate().all(|(at, word)| !words[..at].contains(word))
}

/// The background color one rule, or one style attribute, paints, as the cascade within it
/// decides: an `!important` declaration over any other, then the last one a browser keeps, and
/// `background` sets the color as `background-color` does. None when it declares no background.
/// Some(None) when it paints no color, or when a declaration the pass cannot read (`Unknown`)
/// could win: the last one of the winning importance. The pass never guesses which.
pub fn background<'a>(declarations: impl Iterator<Item = &'a Declaration>) -> Option<Option<Rgba>> {
    let (mut normal, mut important) = (None, None);
    for declaration in
        declarations.filter(|declaration| matches!(declaration.name.as_str(), "background" | "background-color"))
    {
        if declaration.reading.important() {
            important = Some(&declaration.reading);
        } else {
            normal = Some(&declaration.reading);
        }
    }
    important.or(normal).map(|reading| match reading {
        Reading::Known { colors, .. } => match colors.as_slice() {
            [(_, color)] if color.a > 0 => Some(*color),
            _ => None,
        },
        Reading::Unknown { .. } => None,
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
