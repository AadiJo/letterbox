//! Where a body's quoted history starts, so a UI can fold it. Only a quote at the end of a
//! body is found: replies written between quoted lines stay in view.
//!
//! In plain text, the quote starts at the earliest of:
//!   - the trailing block of lines that start with `>` (blank lines may sit among them), or
//!     the attribution line just before it that ends in "wrote:" ("On … wrote:", which may wrap
//!     onto a second line),
//!   - an Outlook divider: a line "-----Original Message-----", or a line of ten or more
//!     underscores followed by a line that starts "From:".
//!
//! In HTML, it starts at the earliest of these elements (see `Scan`):
//!   - a `div` or `blockquote` with a class that ends in `_quote` or `_quoted`, as mail clients
//!     mark the history they quote (Gmail's gmail_quote, Yahoo's yahoo_quoted, Proton's
//!     protonmail_quote), or a `blockquote type="cite"` (Apple Mail, Thunderbird), when nothing
//!     but space follows it. For a `blockquote type="cite"`, the `div` or `p` just before it
//!     starts the quote instead when its text ends in "wrote:".
//!   - an Outlook divider: a `div` with id `divRplyFwdMsg` or `appendonsend`, or a `div` with a
//!     solid top border whose text starts "From:". Everything after it is the quote.
//!
//! Either way the quote needs something before it: a body that is all quote is not folded.

/// The byte offset in `text` of the line where its quote starts, if it ends in one. Linear in
/// the text: each pass over its lines looks at each line once.
pub fn text(text: &str) -> Option<usize> {
    let mut lines = Vec::new();
    let mut start = 0;
    for line in text.split('\n') {
        lines.push((start, line.trim_end_matches('\r')));
        start += line.len() + 1;
    }
    let blank = |index: usize| lines[index].1.trim().is_empty();
    let quoted = |index: usize| lines[index].1.starts_with('>');

    let mut found: Vec<usize> = Vec::new();
    // The trailing block of quoted lines, then the attribution just before it.
    let mut first = lines.len();
    for index in (0..lines.len()).rev() {
        if quoted(index) {
            first = index;
        } else if !blank(index) {
            break;
        }
    }
    if first < lines.len() {
        let mut boundary = first;
        if let Some(before) = (0..first).rev().find(|&index| !blank(index)) {
            let line = lines[before].1.trim();
            if line.to_ascii_lowercase().ends_with("wrote:") {
                let wrapped =
                    !line.starts_with("On ") && before > 0 && lines[before - 1].1.trim_start().starts_with("On ");
                boundary = if wrapped { before - 1 } else { before };
            }
        }
        found.push(boundary);
    }
    // The first Outlook divider. `from_next` walks back once: whether the next line that is
    // not blank, after each line, starts "From:".
    let mut from_next = vec![false; lines.len()];
    let mut next_is_from = false;
    for index in (0..lines.len()).rev() {
        from_next[index] = next_is_from;
        if !blank(index) {
            next_is_from = lines[index].1.trim_start().starts_with("From:");
        }
    }
    let divider = (0..lines.len()).find(|&index| {
        let line = lines[index].1.trim();
        let rule = line.len() >= 10 && line.chars().all(|c| c == '_');
        line.eq_ignore_ascii_case("-----Original Message-----") || rule && from_next[index]
    });
    found.extend(divider);
    let boundary = found.into_iter().min()?;
    (0..boundary).any(|index| !blank(index)).then(|| lines[boundary].0)
}

/// Where an element sits in the first pass over an HTML body: the count of elements started
/// up to and including it, and of start and end tags seen.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Place {
    pub ordinal: u32,
    pub pos: u32,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    /// Holds the quote, and must be followed by nothing but space.
    Container,
    /// Starts the quote, which runs to the end.
    Divider,
    /// Outlook's bordered `div`: a divider once its text is known to start "From:".
    Border,
}

struct Candidate {
    kind: Kind,
    start: Place,
    /// The pos of its end tag. u32::MAX until one is seen, as when the body ends inside it.
    end: u32,
    /// The start of its text, for a Border.
    text: String,
}

/// What the first pass learns about where an HTML body's quote starts. html.rs feeds it each
/// element, each text chunk outside `style`, `script`, `title` and `template`, each image, and
/// each candidate's end tag, then asks for the `boundary`.
#[derive(Default)]
pub struct Scan {
    candidates: Vec<Candidate>,
    /// The latest `div` or `p` and the end of the text since it started, where an attribution sits.
    block: Option<Place>,
    block_text: String,
    first_content: Option<u32>,
    last_content: Option<u32>,
    /// The Border candidates with no text yet, innermost last. A chunk that is not blank moves
    /// every open one to `collecting` and drops the closed ones, so a blank chunk visits none.
    waiting: Vec<usize>,
    /// The Border candidates with some text and less than BORDER_TEXT. Each chunk of text
    /// removes the ones that closed or filled up as it goes through them, wherever they sit.
    collecting: Vec<usize>,
}

/// How much of a Border candidate's text the rules read: enough for "From:".
const BORDER_TEXT: usize = 16;

/// How much of the text since the latest `div` or `p` the rules keep: enough for "wrote:".
const BLOCK_TEXT: usize = 256;

/// The start of `text`, at most `bytes` long, cut at a character boundary.
fn head(text: &str, bytes: usize) -> &str {
    let mut end = bytes.min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// The end of `text`, at most `bytes` long, cut at a character boundary.
fn tail(text: &str, bytes: usize) -> &str {
    let mut start = text.len().saturating_sub(bytes);
    while !text.is_char_boundary(start) {
        start += 1;
    }
    &text[start..]
}

/// The attributes of an element that the quote rules read, with their entities decoded.
pub struct Tag<'a> {
    pub name: &'a str,
    pub class: &'a str,
    pub id: &'a str,
    pub r#type: &'a str,
    pub style: &'a str,
}

impl Scan {
    /// Takes one element. Returns the index of the candidate it is, whose end tag the caller
    /// then reports to `ended`.
    pub fn element(&mut self, at: Place, tag: &Tag<'_>) -> Option<usize> {
        let marked = tag
            .class
            .split_ascii_whitespace()
            .any(|class| class.ends_with("_quote") || class.ends_with("_quoted"));
        let attribution = self
            .block
            .filter(|_| self.block_text.trim_end().to_ascii_lowercase().ends_with("wrote:"));
        let found = match tag.name {
            "div" | "blockquote" if marked => Some((Kind::Container, at)),
            "blockquote" if tag.r#type.eq_ignore_ascii_case("cite") => {
                Some((Kind::Container, attribution.unwrap_or(at)))
            }
            "div" if matches!(tag.id, "divRplyFwdMsg" | "appendonsend") => Some((Kind::Divider, at)),
            "div" if squeezed(tag.style).contains("border-top:solid") => Some((Kind::Border, at)),
            _ => None,
        };
        if matches!(tag.name, "div" | "p") {
            self.block = Some(at);
            self.block_text.clear();
        }
        let (kind, start) = found?;
        self.candidates.push(Candidate {
            kind,
            start,
            end: u32::MAX,
            text: String::new(),
        });
        let index = self.candidates.len() - 1;
        if kind == Kind::Border {
            self.waiting.push(index);
        }
        Some(index)
    }

    /// The end tag of candidate `index`, at `pos`.
    pub fn ended(&mut self, index: usize, pos: u32) {
        if let Some(candidate) = self.candidates.get_mut(index) {
            candidate.end = candidate.end.min(pos);
        }
        self.drop_finished();
    }

    /// Takes the Border candidates that closed off the top of `waiting`.
    fn drop_finished(&mut self) {
        let candidates = &self.candidates;
        while self
            .waiting
            .last()
            .is_some_and(|index| candidates[*index].end != u32::MAX)
        {
            self.waiting.pop();
        }
    }

    /// An image, or text that is not blank, at `pos`.
    pub fn content(&mut self, pos: u32) {
        self.first_content.get_or_insert(pos);
        self.last_content = Some(pos);
    }

    /// Text at `pos`, blank or not. Copies at most BLOCK_TEXT bytes of it, and BORDER_TEXT into
    /// each Border candidate still reading, however long the chunk.
    pub fn text(&mut self, pos: u32, text: &str) {
        self.block_text.push_str(tail(text, BLOCK_TEXT));
        if self.block_text.len() > 2 * BLOCK_TEXT {
            let kept = tail(&self.block_text, BLOCK_TEXT).len();
            self.block_text.drain(..self.block_text.len() - kept);
        }
        let candidates = &mut self.candidates;
        self.collecting.retain(|&index| {
            let candidate = &mut candidates[index];
            if candidate.end != u32::MAX {
                return false;
            }
            candidate.text.push_str(head(text, BORDER_TEXT - candidate.text.len()));
            candidate.text.len() < BORDER_TEXT
        });
        // A candidate's text starts at its first character that is not space, so a blank chunk
        // leaves `waiting` alone, and any other is trimmed once for all of them.
        let trimmed = text.trim_start();
        if !trimmed.is_empty() {
            for index in std::mem::take(&mut self.waiting) {
                let candidate = &mut self.candidates[index];
                if candidate.end == u32::MAX && pos >= candidate.start.pos {
                    candidate.text.push_str(head(trimmed, BORDER_TEXT));
                    if candidate.text.len() < BORDER_TEXT {
                        self.collecting.push(index);
                    }
                }
            }
        }
        self.drop_finished();
    }

    /// True when a Border candidate's text starts "From:". Every other candidate qualifies by its kind.
    fn qualifies(&self, candidate: &Candidate) -> bool {
        candidate.kind != Kind::Border || candidate.text.to_ascii_lowercase().starts_with("from:")
    }

    /// Where the quote starts: the earliest candidate that qualifies.
    pub fn boundary(&self) -> Option<Place> {
        let qualifies = |candidate: &&Candidate| {
            let after_content = self.first_content.is_some_and(|pos| pos < candidate.start.pos);
            let last = match candidate.kind {
                Kind::Container => self.last_content.is_none_or(|pos| pos < candidate.end),
                Kind::Divider => true,
                Kind::Border => self.qualifies(candidate),
            };
            after_content && last
        };
        let found = self.candidates.iter().filter(qualifies);
        found.map(|candidate| candidate.start).min_by_key(|start| start.pos)
    }
}

/// A style attribute lowercased, without its spaces, so a rule can look for a declaration.
fn squeezed(style: &str) -> String {
    style
        .chars()
        .filter(|c| !c.is_whitespace())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

/// True when a text chunk is only space, counting non-breaking spaces as space.
pub fn blank(text: &str) -> bool {
    text.replace("&nbsp;", "")
        .replace("&#160;", "")
        .chars()
        .all(|c| c.is_whitespace())
}
