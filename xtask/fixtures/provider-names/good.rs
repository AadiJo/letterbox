//! Provider-neutral code. The check must report nothing here. Ways it could fail:
//!   - it reports a name in a comment, a doc comment or a block comment
//!   - it reports a name that is only part of a longer word, such as "imap" in "minimap"
//!   - it reads a quote inside a char literal, or a lifetime, as the start of a string
//!   - it ends a raw string at an inner quote, and reads the rest as code
//! Comments may name a provider: Gmail, Outlook, IMAP, X-GM-LABELS, CATEGORY_SOCIAL.

/// Gmail calls these labels and IMAP calls them folders. The core calls both mailboxes.
pub struct Mailbox;

/* Block comments may too: Yahoo, /* nested */ Proton. */
pub const MINIMAP: &str = "minimap";
pub const QUOTE: char = '"';
pub fn first<'a>(text: &'a str) -> &'a str {
    text
}
pub const RAW: &str = r#"a "quoted" word"#;

#[doc = "An attribute doc comment may name a provider as well: Fastmail."]
pub struct Documented;
