//! The dark value of each color a body sets (`Swatch::dark` in crates/protocol/src/body.rs).
//! It works in OKLCH, where lightness is what the eye sees and hue and chroma stay put while it
//! moves, so a brand's orange stays orange. Lightness is turned over between the reader's
//! text (FG, for black) and its background (READER, for white), on a curve for each role:
//!   - text: `FG - span·L²`, which keeps dark text bright (#222 reads near the reader's own
//!     text, a muted grey near its muted grey), and light text keeps its own lightness where
//!     that is lighter, as on a dark button. Then it is lightened until it has FLOOR on the reader.
//!   - background: `READER + span·(1-L)²`, which takes a light page to the reader, while a dark
//!     background keeps its own lightness where that is darker. One with a clear hue (a
//!     brand's button) is lifted to BRAND so it stands off the reader. Either way the reader's
//!     text keeps FLOOR on it: the curve ends at the reader, and BRAND is dark enough.
//!   - border: `FG - span·L`, straight, so a light hairline stays a faint line and a black rule
//!     a bright one.
//!
//! Text and backgrounds are judged apart, since the colour pass does not know which text sits
//! on which background: text keeps its contrast on the reader, and a background keeps it under
//! the reader's text. Light text on a dark background keeps both.

use letterbox_protocol::ColorRole;

use super::color::Rgba;

/// The reader's background, `--color-reader` in the desktop app's styles.css, and its
/// brightest text, `--color-fg`, which black turns into.
const READER: Rgba = Rgba {
    r: 0x1b,
    g: 0x1b,
    b: 0x1e,
    a: 255,
};
const FG: Rgba = Rgba {
    r: 0xf5,
    g: 0xf5,
    b: 0xf5,
    a: 255,
};

/// The contrast text keeps on the reader: WCAG AA.
const FLOOR: f64 = 4.5;

/// The lightness a dark background with a clear hue (OKLCH chroma of at least 0.04) is lifted to.
const BRAND: f64 = 0.42;

/// A color in OKLCH: lightness from 0 to 1, chroma, and hue in radians.
#[derive(Clone, Copy)]
struct Lch {
    l: f64,
    c: f64,
    h: f64,
}

/// The value `color` takes in the dark reader, in the role it plays.
pub fn dark(role: ColorRole, color: Rgba) -> Rgba {
    let lch = lch_of(color);
    let at = |l: f64| rgb_of(Lch { l, ..lch }, color.a);
    let (fg, reader) = (lch_of(FG).l, lch_of(READER).l);
    let span = fg - reader;
    match role {
        ColorRole::Text => {
            let start = lch.l.max(fg - span * lch.l.powi(2));
            let reads = |color: Rgba| contrast(color, READER) >= FLOOR;
            match lowest(start, 1.0, |l| reads(at(l))) {
                Some(l) => at(l),
                // Too faint to read at any lightness: as light as it goes, and as opaque as it must be.
                None => {
                    let lightest = at(1.0);
                    let alpha = (color.a..=255).find(|&a| reads(Rgba { a, ..lightest }));
                    Rgba {
                        a: alpha.unwrap_or(255),
                        ..lightest
                    }
                }
            }
        }
        ColorRole::Background => {
            let turned = reader + span * (1.0 - lch.l).powi(2);
            let start = if turned < lch.l {
                turned
            } else if lch.c >= 0.04 {
                lch.l.max(BRAND)
            } else {
                lch.l
            };
            at(start)
        }
        ColorRole::Border => at(fg - span * lch.l),
    }
}

/// The lowest value in `from..=to` where `holds`, which holds from some point up. None when it
/// does not hold at `to`.
fn lowest(from: f64, to: f64, holds: impl Fn(f64) -> bool) -> Option<f64> {
    if holds(from) {
        return Some(from);
    }
    if !holds(to) {
        return None;
    }
    let (mut low, mut high) = (from, to);
    for _ in 0..24 {
        let middle = f64::midpoint(low, high);
        if holds(middle) { high = middle } else { low = middle }
    }
    Some(high)
}

/// The highest value in `from..=to` where `holds`, which holds from some point down. `from`
/// when it holds nowhere above that.
fn highest(from: f64, to: f64, holds: impl Fn(f64) -> bool) -> f64 {
    if holds(to) {
        return to;
    }
    let (mut low, mut high) = (from, to);
    for _ in 0..24 {
        let middle = f64::midpoint(low, high);
        if holds(middle) { low = middle } else { high = middle }
    }
    low
}

/// WCAG's contrast ratio between two colors, each laid over the reader as the frame shows it.
fn contrast(one: Rgba, other: Rgba) -> f64 {
    let (one, other) = (luminance(one), luminance(other));
    (one.max(other) + 0.05) / (one.min(other) + 0.05)
}

/// WCAG's relative luminance of a color laid over the reader.
fn luminance(color: Rgba) -> f64 {
    let alpha = f64::from(color.a) / 255.0;
    let over = |channel: u8, reader: u8| {
        let mixed = f64::from(channel) * alpha + f64::from(reader) * (1.0 - alpha);
        linear(mixed / 255.0)
    };
    let (r, g, b) = (
        over(color.r, READER.r),
        over(color.g, READER.g),
        over(color.b, READER.b),
    );
    0.2126 * r + 0.7152 * g + 0.0722 * b
}

/// An sRGB channel, 0 to 1, as linear light.
fn linear(channel: f64) -> f64 {
    if channel <= 0.04045 {
        channel / 12.92
    } else {
        ((channel + 0.055) / 1.055).powf(2.4)
    }
}

/// Linear light as an sRGB channel, 0 to 1.
fn gamma(channel: f64) -> f64 {
    if channel <= 0.003_130_8 {
        12.92 * channel
    } else {
        1.055 * channel.powf(1.0 / 2.4) - 0.055
    }
}

/// A color in OKLCH (Björn Ottosson's OKLab, in polar form).
fn lch_of(color: Rgba) -> Lch {
    let [r, g, b] = [color.r, color.g, color.b].map(|channel| linear(f64::from(channel) / 255.0));
    let l = (0.412_221_470_8 * r + 0.536_332_536_3 * g + 0.051_445_992_9 * b).cbrt();
    let m = (0.211_903_498_2 * r + 0.680_699_545_1 * g + 0.107_396_956_6 * b).cbrt();
    let s = (0.088_302_461_9 * r + 0.281_718_837_6 * g + 0.629_978_700_5 * b).cbrt();
    let lightness = 0.210_454_255_3 * l + 0.793_617_785_0 * m - 0.004_072_046_8 * s;
    let a = 1.977_998_495_1 * l - 2.428_592_205_0 * m + 0.450_593_709_9 * s;
    let b = 0.025_904_037_1 * l + 0.782_771_766_2 * m - 0.808_675_766_0 * s;
    Lch {
        l: lightness,
        c: a.hypot(b),
        h: b.atan2(a),
    }
}

/// An OKLCH color as linear sRGB, which may fall outside 0 to 1.
fn linear_of(lch: Lch) -> [f64; 3] {
    let (a, b) = (lch.c * lch.h.cos(), lch.c * lch.h.sin());
    let l = (lch.l + 0.396_337_777_4 * a + 0.215_803_757_3 * b).powi(3);
    let m = (lch.l - 0.105_561_345_8 * a - 0.063_854_172_8 * b).powi(3);
    let s = (lch.l - 0.089_484_177_5 * a - 1.291_485_548_0 * b).powi(3);
    [
        4.076_741_662_1 * l - 3.307_711_591_3 * m + 0.230_969_929_2 * s,
        -1.268_438_004_6 * l + 2.609_757_401_1 * m - 0.341_319_396_5 * s,
        -0.004_196_086_3 * l - 0.703_418_614_7 * m + 1.707_614_701_0 * s,
    ]
}

/// The sRGB color at `lch`, with alpha `a`. One outside sRGB loses chroma until it fits, so its
/// hue and lightness hold.
fn rgb_of(lch: Lch, a: u8) -> Rgba {
    let lch = Lch {
        l: lch.l.clamp(0.0, 1.0),
        ..lch
    };
    let fits = |c: f64| {
        let channels = linear_of(Lch { c, ..lch });
        channels.iter().all(|channel| (-1e-6..=1.0 + 1e-6).contains(channel))
    };
    let c = if fits(lch.c) { lch.c } else { highest(0.0, lch.c, fits) };
    let byte = |channel: f64| (gamma(channel.clamp(0.0, 1.0)) * 255.0).round() as u8;
    let [r, g, b] = linear_of(Lch { c, ..lch });
    Rgba {
        r: byte(r),
        g: byte(g),
        b: byte(b),
        a,
    }
}
