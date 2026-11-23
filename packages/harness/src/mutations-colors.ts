// Breaks in the colour pass (crates/core/src/body/paint.rs, dark.rs, scheme.rs): how colors are
// named, their dark values, the look, and the choice of scheme per sender. mutations.ts runs
// them with the others.

import type { Mutation } from './breaks.ts'

const body = (file: string) => `crates/core/src/body/${file}`

const COLORS = 'html colors are named'
const SEEDS = "every dev seed's html"

export const COLOR_MUTATIONS: Mutation[] = [
  {
    name: 'dark text keeps its own lightness, so #222 stays near black on the dark reader',
    file: body('dark.rs'),
    find: 'let start = lch.l.max(fg - span * lch.l.powi(2));',
    replace: 'let start = lch.l;',
    scenarios: COLORS,
  },
  {
    name: 'faint text is not made readable, so it sits under the contrast floor',
    file: body('dark.rs'),
    find: 'match lowest(start, 1.0, |l| reads(at(l))) {',
    replace: 'match Some(start) {',
    scenarios: COLORS,
  },
  {
    name: 'a color outside sRGB is clipped channel by channel, which shifts its hue',
    file: body('dark.rs'),
    find: 'let c = if fits(lch.c) {',
    replace: 'let c = if true {',
    scenarios: COLORS,
  },
  {
    name: 'a bgcolor is left as the sender set it, so a white table stays white in the dark reader',
    file: body('paint.rs'),
    find: 'if on.is_some_and(|on| on != name) {',
    replace: 'if on.is_none_or(|on| on != name) {',
    scenarios: COLORS,
  },
  {
    name: 'a bgcolor is read as CSS, so one written without # keeps its own color',
    file: body('paint.rs'),
    find: '.and_then(|value| color::legacy(&value))',
    replace: '.and_then(|value| color::color_of(&value))',
    scenarios: COLORS,
  },
  {
    name: "a color attribute's rule outranks the sender's own rules",
    file: body('paint.rs'),
    find: '":where({selector}){{{property}:var(--letterbox-color-{index}, {})}}",',
    replace: '"{selector}{{{property}:var(--letterbox-color-{index}, {})}}",',
    scenarios: COLORS,
  },
  {
    name: "a sender sets the core's own color names",
    file: body('paint.rs'),
    find: 'if css.contains("--letterbox-") {',
    replace: 'if false && css.contains("--letterbox-") {',
    scenarios: COLORS,
  },
  {
    name: 'a selector with a colon hides the colors in its block',
    file: body('paint.rs'),
    find: '            at = end + 1;\n        } else {',
    replace: '            at = until(bytes, end + 1, b"}") + 1;\n        } else {',
    scenarios: COLORS,
  },
  {
    name: 'a color name inside a string is restyled, which garbles the string',
    file: body('paint.rs'),
    find: "quote @ (b'\"' | b'\\'') => at = string_end(bytes, at, quote),",
    replace: "b'\"' | b'\\'' => at += 1,",
    scenarios: COLORS,
  },
  {
    name: 'a color name inside a url() is restyled, which breaks the url',
    file: body('paint.rs'),
    find: 'if matches!(function.as_str(), "url" | "rgb" | "rgba" | "hsl" | "hsla") {',
    replace: 'if matches!(function.as_str(), "rgb" | "rgba" | "hsl" | "hsla") {',
    scenarios: COLORS,
  },
  {
    name: 'hidden text with no alpha gets a dark value, which shows it',
    file: body('paint.rs'),
    find: 'if color.a == 0 {',
    replace: 'if false {',
    scenarios: COLORS,
  },
  {
    name: 'each spelling of a color gets its own swatch',
    file: body('paint.rs'),
    find: 'if let Some(index) = self.places.get(&(role, color)) {',
    replace: 'if let Some(index) = self.places.get(&(role, color)).filter(|_| false) {',
    scenarios: COLORS,
  },
  {
    name: "a table nested in another passes for a person's plain table",
    file: body('paint.rs'),
    find: 'self.designed |= nested || presentation;',
    replace: 'self.designed |= presentation;',
    scenarios: COLORS,
  },
  {
    name: "a presentation table passes for a person's plain table",
    file: body('paint.rs'),
    find: 'self.designed |= nested || presentation;',
    replace: 'self.designed |= nested;',
    scenarios: COLORS,
  },
  {
    name: 'a background image or gradient does not make mail branded',
    file: body('paint.rs'),
    find: '.any(|image| value.to_ascii_lowercase().contains(image))\n            {\n                self.designed = true;',
    replace:
      '.any(|image| value.to_ascii_lowercase().contains(image))\n            {\n                self.designed = false;',
    scenarios: COLORS,
  },
  {
    name: 'many hues do not make mail branded',
    file: body('paint.rs'),
    find: 'let branded = self.designed || hues >= MANY_HUES;',
    replace: 'let branded = self.designed || hues > 99;',
    scenarios: COLORS,
  },
  {
    name: "a machine's plain html takes the reader's type",
    file: body('mod.rs'),
    find: 'let look = if processed.branded || crate::turns::is_automated(&record.facts) {',
    replace: 'let look = if processed.branded {',
    scenarios: COLORS,
  },
  {
    name: "the colour pass reads the sender's css, not the rewritten one, and brings a remote image back",
    file: body('rewrite.rs'),
    find: 'let colored = self.paint.css(images.as_deref().unwrap_or(&own));',
    replace: 'let colored = self.paint.css(&own);',
    scenarios: COLORS,
  },
  {
    name: "a sender's choice is not written to the store, so a restart forgets it",
    file: 'crates/core/src/world.rs',
    find: "pub fn put_sender(world: &mut World, tx: &Transaction<'_>, record: SenderRecord) {\n    tx.put(&record);",
    replace: "pub fn put_sender(world: &mut World, tx: &Transaction<'_>, record: SenderRecord) {\n    let _ = tx;",
    scenarios: COLORS,
  },
  {
    name: "a sender's choice does not redraw its other open conversations",
    file: 'crates/core/src/world.rs',
    find: 'world.touched.threads.extend(threads);',
    replace: 'drop(threads.count());',
    scenarios: COLORS,
  },
  {
    name: "a sender's address in capitals counts as another sender",
    file: body('scheme.rs'),
    find: 'SenderKey(scoped(account_id, &address.to_lowercase()))',
    replace: 'SenderKey(scoped(account_id, address))',
    scenarios: COLORS,
  },
  {
    name: 'the rules version stays, so bodies stored before the colour pass are never named',
    file: body('mod.rs'),
    find: 'const VERSION: u32 = 5;',
    replace: 'const VERSION: u32 = 4;',
    scenarios: 'a stored reading survives a restart',
  },
  {
    name: "the check on the core's output is skipped, so a dev seed's html the rewrite cannot make safe reaches the frame",
    file: body('html.rs'),
    find: '    if !safe(&html) {',
    replace: '    if !safe(&html) && false {',
    scenarios: SEEDS,
  },
]
