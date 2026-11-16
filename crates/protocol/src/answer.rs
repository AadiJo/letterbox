//! The answer to a request: a result or an error, and the plain values the wire uses for them.

use serde::{Serialize, Serializer};
use ts_rs::TS;

/// A result or an error. On the wire: `{"ok": true, "result": ...}` or `{"ok": false, "error": ...}`.
/// Build one from a `Result` with `Answer::from`.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(untagged)]
pub enum Answer<T, E> {
    Ok { ok: True, result: T },
    Err { ok: False, error: E },
}

impl<T, E> From<Result<T, E>> for Answer<T, E> {
    fn from(result: Result<T, E>) -> Self {
        match result {
            Ok(result) => Answer::Ok { ok: True, result },
            Err(error) => Answer::Err { ok: False, error },
        }
    }
}

/// `true` on the wire, and `true` in TypeScript: the `ok` of a success.
#[derive(Clone, Copy, Debug, PartialEq, Eq, TS)]
#[ts(type = "true")]
pub struct True;

impl Serialize for True {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bool(true)
    }
}

/// `false` on the wire, and `false` in TypeScript: the `ok` of a failure.
#[derive(Clone, Copy, Debug, PartialEq, Eq, TS)]
#[ts(type = "false")]
pub struct False;

impl Serialize for False {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bool(false)
    }
}

/// A result with no fields: `{}`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[ts(type = "Record<string, never>")]
pub struct Empty {}

/// An error that cannot happen.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
pub enum Never {}
