//! Colors as a body writes them: a CSS color (`color_of`) or an HTML color attribute such as
//! `bgcolor` (`legacy`), read as a browser reads them, and written back as hex (`Rgba::hex`).
//! The colour pass (paint.rs) finds them, and dark.rs gives each its value for a dark reader.

/// An sRGB color with alpha, 8 bits each, as a browser keeps a parsed sRGB color.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Rgba {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8,
}

impl Rgba {
    /// `#rrggbb`, or `#rrggbbaa` when it is not opaque.
    pub fn hex(self) -> String {
        let Rgba { r, g, b, a } = self;
        if a == 255 {
            format!("#{r:02x}{g:02x}{b:02x}")
        } else {
            format!("#{r:02x}{g:02x}{b:02x}{a:02x}")
        }
    }

    fn opaque(rgb: u32) -> Rgba {
        let [_, r, g, b] = rgb.to_be_bytes();
        Rgba { r, g, b, a: 255 }
    }
}

/// One CSS color value: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()`, `hsl()`,
/// `hsla()` or a named color, in any case. None for anything else, which the colour pass leaves
/// as it is: `transparent`, `currentcolor`, a `var()`, and the newer spaces (`oklch()`, `lab()`).
pub fn color_of(token: &str) -> Option<Rgba> {
    let token = token.trim();
    if let Some(hex) = token.strip_prefix('#') {
        return hex_of(hex);
    }
    if let Some(open) = token.find('(') {
        let name = token[..open].to_ascii_lowercase();
        let inner = token[open + 1..].strip_suffix(')')?;
        return match name.as_str() {
            "rgb" | "rgba" => rgb(inner),
            "hsl" | "hsla" => hsl(inner),
            _ => None,
        };
    }
    named(token)
}

/// `#` and 3, 4, 6 or 8 hex digits, without the `#`.
fn hex_of(hex: &str) -> Option<Rgba> {
    if !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let digit = |at: usize| u8::from_str_radix(&hex[at..=at], 16).ok().map(|value| value * 17);
    let pair = |at: usize| u8::from_str_radix(&hex[at..at + 2], 16).ok();
    match hex.len() {
        3 | 4 => Some(Rgba {
            r: digit(0)?,
            g: digit(1)?,
            b: digit(2)?,
            a: if hex.len() == 4 { digit(3)? } else { 255 },
        }),
        6 | 8 => Some(Rgba {
            r: pair(0)?,
            g: pair(2)?,
            b: pair(4)?,
            a: if hex.len() == 8 { pair(6)? } else { 255 },
        }),
        _ => None,
    }
}

/// The arguments of `rgb()` or `hsl()`, in one of CSS Color 4's two forms: three separated by
/// commas, with an optional alpha after a fourth comma (`legacy`), or three separated by space,
/// with an optional alpha after a slash. None for anything else, such as `rgb(0 0 0 .35)`,
/// which a browser drops: the colour pass then leaves the declaration as it is.
struct Arguments<'a> {
    values: [&'a str; 3],
    alpha: Option<&'a str>,
    legacy: bool,
}

fn arguments(inner: &str) -> Option<Arguments<'_>> {
    let single = |part: &str| !part.is_empty() && !part.contains(|c: char| c.is_ascii_whitespace() || c == '/');
    if inner.contains(',') {
        let parts: Vec<&str> = inner.split(',').map(str::trim).collect();
        if !parts.iter().all(|part| single(part)) {
            return None;
        }
        return match parts.as_slice() {
            [a, b, c] => Some(Arguments {
                values: [a, b, c],
                alpha: None,
                legacy: true,
            }),
            [a, b, c, alpha] => Some(Arguments {
                values: [a, b, c],
                alpha: Some(alpha),
                legacy: true,
            }),
            _ => None,
        };
    }
    let (values, alpha) = match inner.split_once('/') {
        Some((values, alpha)) => (values, Some(alpha.trim())),
        None => (inner, None),
    };
    if alpha.is_some_and(|alpha| !single(alpha)) {
        return None;
    }
    match values.split_ascii_whitespace().collect::<Vec<_>>().as_slice() {
        [a, b, c] => Some(Arguments {
            values: [a, b, c],
            alpha,
            legacy: false,
        }),
        _ => None,
    }
}

/// One argument: a number or a percentage, as CSS writes them.
#[derive(Clone, Copy)]
enum Value {
    Number(f64),
    Percent(f64),
}

fn value(text: &str) -> Option<Value> {
    match text.strip_suffix('%') {
        Some(percent) => css_number(percent).map(Value::Percent),
        None => css_number(text).map(Value::Number),
    }
}

/// A CSS number, as its syntax writes one: an optional sign, digits with at most one point and
/// a digit after it, and an optional exponent. Rust's own parse takes more (`inf`, `1.`).
fn css_number(text: &str) -> Option<f64> {
    let bytes = text.as_bytes();
    let mut at = usize::from(matches!(bytes.first(), Some(b'+' | b'-')));
    let digits = |at: &mut usize| {
        let start = *at;
        while bytes.get(*at).is_some_and(u8::is_ascii_digit) {
            *at += 1;
        }
        *at - start
    };
    let whole = digits(&mut at);
    let mut fraction = 0;
    if bytes.get(at) == Some(&b'.') {
        at += 1;
        fraction = digits(&mut at);
        if fraction == 0 {
            return None;
        }
    }
    if whole + fraction == 0 {
        return None;
    }
    if matches!(bytes.get(at), Some(b'e' | b'E')) {
        at += 1;
        if matches!(bytes.get(at), Some(b'+' | b'-')) {
            at += 1;
        }
        if digits(&mut at) == 0 {
            return None;
        }
    }
    let number: f64 = text.parse().ok()?;
    (at == bytes.len() && number.is_finite()).then_some(number)
}

/// A channel from 0 to 1 as 8 bits.
fn byte(unit: f64) -> u8 {
    (unit.clamp(0.0, 1.0) * 255.0).round() as u8
}

/// The alpha after the color's values: a number from 0 to 1, or a percentage. Opaque when none.
fn alpha(text: Option<&str>) -> Option<u8> {
    match text.map(value) {
        None => Some(255),
        Some(Some(Value::Number(number))) => Some(byte(number)),
        Some(Some(Value::Percent(percent))) => Some(byte(percent / 100.0)),
        Some(None) => None,
    }
}

/// `rgb()` or `rgba()`: three numbers from 0 to 255 or three percentages, which the comma form
/// may not mix.
fn rgb(inner: &str) -> Option<Rgba> {
    let Arguments {
        values,
        alpha: a,
        legacy,
    } = arguments(inner)?;
    let values = values.map(value);
    let numbers = values.iter().all(|value| matches!(value, Some(Value::Number(_))));
    let percents = values.iter().all(|value| matches!(value, Some(Value::Percent(_))));
    if legacy && !numbers && !percents {
        return None;
    }
    let channel = |value: Option<Value>| match value? {
        Value::Number(number) => Some(byte(number / 255.0)),
        Value::Percent(percent) => Some(byte(percent / 100.0)),
    };
    let [r, g, b] = values;
    Some(Rgba {
        r: channel(r)?,
        g: channel(g)?,
        b: channel(b)?,
        a: alpha(a)?,
    })
}

/// A hue: a number of degrees, or an angle in `deg`, `grad`, `rad` or `turn`.
fn hue(text: &str) -> Option<f64> {
    let lower = text.to_ascii_lowercase();
    let units = [
        ("deg", 1.0),
        ("grad", 0.9),
        ("rad", 180.0 / std::f64::consts::PI),
        ("turn", 360.0),
    ];
    let (number, scale) = units
        .iter()
        .find_map(|(unit, scale)| lower.strip_suffix(unit).map(|number| (number, *scale)))
        .unwrap_or((lower.as_str(), 1.0));
    Some((css_number(number)? * scale).rem_euclid(360.0))
}

/// `hsl()` or `hsla()`: a hue, then saturation and lightness as percentages, or in the space
/// form also as plain numbers of percent.
fn hsl(inner: &str) -> Option<Rgba> {
    let Arguments {
        values: [h, s, l],
        alpha: a,
        legacy,
    } = arguments(inner)?;
    let hue = hue(h)?;
    let percent = |text: &str| match value(text)? {
        Value::Percent(percent) => Some(percent / 100.0),
        Value::Number(number) if !legacy => Some(number / 100.0),
        Value::Number(_) => None,
    };
    let (s, l) = (percent(s)?.clamp(0.0, 1.0), percent(l)?.clamp(0.0, 1.0));
    // CSS Color 4, "Converting HSL colors to sRGB colors".
    let channel = |n: f64| {
        let k = (n + hue / 30.0) % 12.0;
        l - s * l.min(1.0 - l) * (k - 3.0).min(9.0 - k).clamp(-1.0, 1.0)
    };
    Some(Rgba {
        r: byte(channel(0.0)),
        g: byte(channel(8.0)),
        b: byte(channel(4.0)),
        a: alpha(a)?,
    })
}

/// An HTML color attribute (`bgcolor`, `<font color>`, `<body text>`), read by the HTML
/// standard's rules for parsing a legacy color value, so `ffffff` with no `#` and even
/// `chucknorris` mean what a browser shows. None for an empty value or `transparent`.
pub fn legacy(value: &str) -> Option<Rgba> {
    let value = value.trim_matches(|c: char| c.is_ascii_whitespace());
    if value.is_empty() || value.eq_ignore_ascii_case("transparent") {
        return None;
    }
    if let Some(color) = named(value) {
        return Some(color);
    }
    if value.len() == 4
        && let Some(hex) = value.strip_prefix('#')
        && let Some(color) = hex_of(hex)
    {
        return Some(color);
    }
    let widened: String = value
        .chars()
        .flat_map(|c| if u32::from(c) > 0xFFFF { vec!['0', '0'] } else { vec![c] })
        .take(128)
        .collect();
    let mut digits: Vec<u8> = widened
        .strip_prefix('#')
        .unwrap_or(&widened)
        .chars()
        .map(|c| if c.is_ascii_hexdigit() { c as u8 } else { b'0' })
        .collect();
    while digits.is_empty() || !digits.len().is_multiple_of(3) {
        digits.push(b'0');
    }
    let mut parts: Vec<&[u8]> = digits.chunks(digits.len() / 3).collect();
    for part in &mut parts {
        if part.len() > 8 {
            *part = &part[part.len() - 8..];
        }
    }
    while parts[0].len() > 2 && parts.iter().all(|part| part[0] == b'0') {
        for part in &mut parts {
            *part = &part[1..];
        }
    }
    let channel = |part: &[u8]| {
        let two = &part[..part.len().min(2)];
        u8::from_str_radix(std::str::from_utf8(two).ok()?, 16).ok()
    };
    Some(Rgba {
        r: channel(parts[0])?,
        g: channel(parts[1])?,
        b: channel(parts[2])?,
        a: 255,
    })
}

/// A CSS named color, in any case.
pub fn named(name: &str) -> Option<Rgba> {
    if name.len() > 20 || !name.bytes().all(|byte| byte.is_ascii_alphabetic()) {
        return None;
    }
    let name = name.to_ascii_lowercase();
    let at = NAMED.binary_search_by(|(known, _)| known.cmp(&name.as_str())).ok()?;
    Some(Rgba::opaque(NAMED[at].1))
}

/// CSS Color 4's named colors, sorted by name for `named`'s search.
const NAMED: [(&str, u32); 148] = [
    ("aliceblue", 0xf0f8ff),
    ("antiquewhite", 0xfaebd7),
    ("aqua", 0x00ffff),
    ("aquamarine", 0x7fffd4),
    ("azure", 0xf0ffff),
    ("beige", 0xf5f5dc),
    ("bisque", 0xffe4c4),
    ("black", 0x000000),
    ("blanchedalmond", 0xffebcd),
    ("blue", 0x0000ff),
    ("blueviolet", 0x8a2be2),
    ("brown", 0xa52a2a),
    ("burlywood", 0xdeb887),
    ("cadetblue", 0x5f9ea0),
    ("chartreuse", 0x7fff00),
    ("chocolate", 0xd2691e),
    ("coral", 0xff7f50),
    ("cornflowerblue", 0x6495ed),
    ("cornsilk", 0xfff8dc),
    ("crimson", 0xdc143c),
    ("cyan", 0x00ffff),
    ("darkblue", 0x00008b),
    ("darkcyan", 0x008b8b),
    ("darkgoldenrod", 0xb8860b),
    ("darkgray", 0xa9a9a9),
    ("darkgreen", 0x006400),
    ("darkgrey", 0xa9a9a9),
    ("darkkhaki", 0xbdb76b),
    ("darkmagenta", 0x8b008b),
    ("darkolivegreen", 0x556b2f),
    ("darkorange", 0xff8c00),
    ("darkorchid", 0x9932cc),
    ("darkred", 0x8b0000),
    ("darksalmon", 0xe9967a),
    ("darkseagreen", 0x8fbc8f),
    ("darkslateblue", 0x483d8b),
    ("darkslategray", 0x2f4f4f),
    ("darkslategrey", 0x2f4f4f),
    ("darkturquoise", 0x00ced1),
    ("darkviolet", 0x9400d3),
    ("deeppink", 0xff1493),
    ("deepskyblue", 0x00bfff),
    ("dimgray", 0x696969),
    ("dimgrey", 0x696969),
    ("dodgerblue", 0x1e90ff),
    ("firebrick", 0xb22222),
    ("floralwhite", 0xfffaf0),
    ("forestgreen", 0x228b22),
    ("fuchsia", 0xff00ff),
    ("gainsboro", 0xdcdcdc),
    ("ghostwhite", 0xf8f8ff),
    ("gold", 0xffd700),
    ("goldenrod", 0xdaa520),
    ("gray", 0x808080),
    ("green", 0x008000),
    ("greenyellow", 0xadff2f),
    ("grey", 0x808080),
    ("honeydew", 0xf0fff0),
    ("hotpink", 0xff69b4),
    ("indianred", 0xcd5c5c),
    ("indigo", 0x4b0082),
    ("ivory", 0xfffff0),
    ("khaki", 0xf0e68c),
    ("lavender", 0xe6e6fa),
    ("lavenderblush", 0xfff0f5),
    ("lawngreen", 0x7cfc00),
    ("lemonchiffon", 0xfffacd),
    ("lightblue", 0xadd8e6),
    ("lightcoral", 0xf08080),
    ("lightcyan", 0xe0ffff),
    ("lightgoldenrodyellow", 0xfafad2),
    ("lightgray", 0xd3d3d3),
    ("lightgreen", 0x90ee90),
    ("lightgrey", 0xd3d3d3),
    ("lightpink", 0xffb6c1),
    ("lightsalmon", 0xffa07a),
    ("lightseagreen", 0x20b2aa),
    ("lightskyblue", 0x87cefa),
    ("lightslategray", 0x778899),
    ("lightslategrey", 0x778899),
    ("lightsteelblue", 0xb0c4de),
    ("lightyellow", 0xffffe0),
    ("lime", 0x00ff00),
    ("limegreen", 0x32cd32),
    ("linen", 0xfaf0e6),
    ("magenta", 0xff00ff),
    ("maroon", 0x800000),
    ("mediumaquamarine", 0x66cdaa),
    ("mediumblue", 0x0000cd),
    ("mediumorchid", 0xba55d3),
    ("mediumpurple", 0x9370db),
    ("mediumseagreen", 0x3cb371),
    ("mediumslateblue", 0x7b68ee),
    ("mediumspringgreen", 0x00fa9a),
    ("mediumturquoise", 0x48d1cc),
    ("mediumvioletred", 0xc71585),
    ("midnightblue", 0x191970),
    ("mintcream", 0xf5fffa),
    ("mistyrose", 0xffe4e1),
    ("moccasin", 0xffe4b5),
    ("navajowhite", 0xffdead),
    ("navy", 0x000080),
    ("oldlace", 0xfdf5e6),
    ("olive", 0x808000),
    ("olivedrab", 0x6b8e23),
    ("orange", 0xffa500),
    ("orangered", 0xff4500),
    ("orchid", 0xda70d6),
    ("palegoldenrod", 0xeee8aa),
    ("palegreen", 0x98fb98),
    ("paleturquoise", 0xafeeee),
    ("palevioletred", 0xdb7093),
    ("papayawhip", 0xffefd5),
    ("peachpuff", 0xffdab9),
    ("peru", 0xcd853f),
    ("pink", 0xffc0cb),
    ("plum", 0xdda0dd),
    ("powderblue", 0xb0e0e6),
    ("purple", 0x800080),
    ("rebeccapurple", 0x663399),
    ("red", 0xff0000),
    ("rosybrown", 0xbc8f8f),
    ("royalblue", 0x4169e1),
    ("saddlebrown", 0x8b4513),
    ("salmon", 0xfa8072),
    ("sandybrown", 0xf4a460),
    ("seagreen", 0x2e8b57),
    ("seashell", 0xfff5ee),
    ("sienna", 0xa0522d),
    ("silver", 0xc0c0c0),
    ("skyblue", 0x87ceeb),
    ("slateblue", 0x6a5acd),
    ("slategray", 0x708090),
    ("slategrey", 0x708090),
    ("snow", 0xfffafa),
    ("springgreen", 0x00ff7f),
    ("steelblue", 0x4682b4),
    ("tan", 0xd2b48c),
    ("teal", 0x008080),
    ("thistle", 0xd8bfd8),
    ("tomato", 0xff6347),
    ("turquoise", 0x40e0d0),
    ("violet", 0xee82ee),
    ("wheat", 0xf5deb3),
    ("white", 0xffffff),
    ("whitesmoke", 0xf5f5f5),
    ("yellow", 0xffff00),
    ("yellowgreen", 0x9acd32),
];
