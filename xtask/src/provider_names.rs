//! Finds provider names in Rust source, outside comments.
//!
//! The source is lexed with proc-macro2, the lexer macros use, so plain comments
//! are dropped and strings, raw strings and macro bodies arrive as tokens. Doc
//! comments arrive as `#[doc = "..."]` attributes, which are skipped like comments.

use proc_macro2::{Delimiter, Group, LexError, Span, TokenStream, TokenTree};

/// The words, one per line. lint/rules/no-provider-names.ts reads the same file.
const TERMS: &str = include_str!("../../lint/provider-terms.txt");

/// One token that names a provider.
pub struct Finding {
    pub line: usize,
    /// The name as written in the source, for example "Gmail".
    pub term: String,
}

/// Every token in `source` that names a provider, in source order.
pub fn find(source: &str) -> Result<Vec<Finding>, LexError> {
    let tokens: TokenStream = source.parse()?;
    let mut found = Vec::new();
    walk(tokens, &mut found);
    Ok(found)
}

fn walk(tokens: TokenStream, found: &mut Vec<Finding>) {
    let mut tokens = tokens.into_iter().peekable();
    while let Some(token) = tokens.next() {
        match token {
            TokenTree::Punct(punct) if punct.as_char() == '#' => {
                // An attribute, #[...] or #![...]. A doc comment is one, and comments may name a provider.
                if matches!(tokens.peek(), Some(TokenTree::Punct(bang)) if bang.as_char() == '!') {
                    tokens.next();
                }
                if matches!(tokens.peek(), Some(TokenTree::Group(group)) if is_doc_comment(group)) {
                    tokens.next();
                }
            }
            TokenTree::Group(group) => walk(group.stream(), found),
            TokenTree::Ident(ident) => check(&ident.to_string(), ident.span(), found),
            TokenTree::Literal(literal) => check(&literal.to_string(), literal.span(), found),
            TokenTree::Punct(_) => {}
        }
    }
}

/// True for the `[doc = "..."]` part of a doc comment.
fn is_doc_comment(group: &Group) -> bool {
    let mut inside = group.stream().into_iter();
    group.delimiter() == Delimiter::Bracket
        && matches!(inside.next(), Some(TokenTree::Ident(ident)) if ident == "doc")
        && matches!(inside.next(), Some(TokenTree::Punct(equals)) if equals.as_char() == '=')
}

fn check(text: &str, span: Span, found: &mut Vec<Finding>) {
    if let Some(term) = term_in(text) {
        found.push(Finding {
            line: span.start().line,
            term,
        });
    }
}

/// The first word from TERMS that stands in `text` as a whole word: "imap" in "imap_uid", but not in "minimap".
fn term_in(text: &str) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    let bytes = text.as_bytes();
    let terms = TERMS
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'));
    for term in terms {
        for (at, matched) in lower.match_indices(term) {
            let end = at + matched.len();
            if is_word_boundary(bytes, at) && is_word_boundary(bytes, end) {
                return Some(text[at..end].to_owned());
            }
        }
    }
    None
}

/// True when a word can start or end between text[index - 1] and text[index]: at either
/// end, next to anything that is not a letter, at a camelCase hump ("gmail|Label") and
/// after an acronym ("IMAP|Client").
fn is_word_boundary(text: &[u8], index: usize) -> bool {
    let before = index.checked_sub(1).and_then(|at| text.get(at));
    let (Some(&before), Some(&after)) = (before, text.get(index)) else {
        return true;
    };
    if !before.is_ascii_alphabetic() || !after.is_ascii_alphabetic() {
        return true;
    }
    if before.is_ascii_lowercase() && after.is_ascii_uppercase() {
        return true;
    }
    before.is_ascii_uppercase() && after.is_ascii_uppercase() && text.get(index + 1).is_some_and(u8::is_ascii_lowercase)
}
