//! Colors as a body writes them, read as a browser reads them and written back as hex
//! (`Rgba::hex`): a CSS color's parts, which css.rs takes from cssparser's tokens (`hex`,
//! `named`, `rgb`, `hsl`), or an HTML color attribute such as `bgcolor` (`legacy`). The colour
//! pass (paint.rs) finds them, and dark.rs gives each its value for a dark reader.

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
}

/// A hex color's digits, without the `#`: 3, 4, 6 or 8 of them.
pub fn hex(digits: &str) -> Option<Rgba> {
    let (r, g, b, alpha) = cssparser::color::parse_hash_color(digits.as_bytes()).ok()?;
    Some(Rgba {
        r,
        g,
        b,
        a: byte(f64::from(alpha)),
    })
}

/// A CSS named color, in any case. `transparent` and `currentcolor` are not among them.
pub fn named(name: &str) -> Option<Rgba> {
    let (r, g, b) = cssparser::color::parse_named_color(&name.to_ascii_lowercase()).ok()?;
    Some(Rgba { r, g, b, a: 255 })
}

/// One argument of `rgb()` or `hsl()`, from its token.
#[derive(Clone, Copy)]
pub enum Value {
    Number(f64),
    /// A percentage, 0 to 100.
    Percent(f64),
    /// An angle, in degrees: a hue with a unit.
    Angle(f64),
}

/// A channel from 0 to 1 as 8 bits.
fn byte(unit: f64) -> u8 {
    (unit.clamp(0.0, 1.0) * 255.0).round() as u8
}

/// The alpha after a color's values: a number from 0 to 1, or a percentage. Opaque when none.
fn alpha(value: Option<Value>) -> Option<u8> {
    match value {
        None => Some(255),
        Some(Value::Number(number)) => Some(byte(number)),
        Some(Value::Percent(percent)) => Some(byte(percent / 100.0)),
        Some(Value::Angle(_)) => None,
    }
}

/// `rgb()` or `rgba()`: three numbers from 0 to 255 or three percentages, which the comma
/// form (`legacy`) may not mix.
pub fn rgb(values: [Value; 3], alpha_value: Option<Value>, legacy: bool) -> Option<Rgba> {
    let numbers = values.iter().all(|value| matches!(value, Value::Number(_)));
    let percents = values.iter().all(|value| matches!(value, Value::Percent(_)));
    if legacy && !numbers && !percents {
        return None;
    }
    let channel = |value: Value| match value {
        Value::Number(number) => Some(byte(number / 255.0)),
        Value::Percent(percent) => Some(byte(percent / 100.0)),
        Value::Angle(_) => None,
    };
    let [r, g, b] = values;
    Some(Rgba {
        r: channel(r)?,
        g: channel(g)?,
        b: channel(b)?,
        a: alpha(alpha_value)?,
    })
}

/// `hsl()` or `hsla()`: a hue (a number of degrees or an angle), then saturation and lightness
/// as percentages, or in the space form also as plain numbers of percent.
pub fn hsl(values: [Value; 3], alpha_value: Option<Value>, legacy: bool) -> Option<Rgba> {
    let [h, s, l] = values;
    let hue = match h {
        Value::Number(degrees) | Value::Angle(degrees) => degrees.rem_euclid(360.0),
        Value::Percent(_) => return None,
    };
    let percent = |value: Value| match value {
        Value::Percent(percent) => Some(percent / 100.0),
        Value::Number(number) if !legacy => Some(number / 100.0),
        Value::Number(_) | Value::Angle(_) => None,
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
        a: alpha(alpha_value)?,
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
        && let Some(digits) = value.strip_prefix('#')
        && let Some(color) = hex(digits)
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
