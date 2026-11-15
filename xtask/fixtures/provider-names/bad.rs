// Code that names providers. The check must report every line that ends in a
// "flagged" marker, and no other line. Ways it could fail on this file:
//   - it misses a name in an identifier, in any casing style
//   - it misses a name in a string, raw string or byte string
//   - it misses a name inside a macro call, which is tokens, not a parsed expression
//   - it reports a line other than the one the name is on
//   - it is hidden by a comment that follows the code on the same line

pub const GMAIL_LABELS: [&str; 1] = ["a"]; // flagged
pub struct ImapClient; // flagged
pub fn is_outlook() -> bool { // flagged
    false
}
pub type JmapSession = (); // flagged

pub const HOST: &str = "imap.fastmail.com"; // flagged
pub const HEADER: &str = r#"X-GM-LABELS"#; // flagged
pub const RAW_BYTES: &[u8] = b"CATEGORY_PROMOTIONS"; // flagged

pub fn greeting(name: &str) -> String {
    format!("{name} uses Proton") // flagged
}

pub const SIGN_IN: &str = "https://accounts.google.com/o/oauth2/v2/auth"; // flagged
pub const URL: &str = "// not a comment: yahoo"; // flagged
