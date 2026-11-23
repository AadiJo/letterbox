//! Unsubscribing from a sender: what Updates shows of it. The `unsubscribe` command
//! (command.rs) starts one, and `undo` takes it back while it is held.

use serde::Serialize;
use ts_rs::TS;

use crate::{ChangeId, Time};

/// How an unsubscribe goes out, or went out.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum UnsubscribeMethod {
    /// A POST of `List-Unsubscribe=One-Click` to the sender's URL, sent by the core (RFC 8058).
    OneClick,
    /// An email from the account to the sender's unsubscribe address, through the outbox.
    Mailto,
    /// The sender's page, which the user opens in the browser. The core never opens it.
    Web,
}

/// Where the user's unsubscribe from a sender has got, on its row in Updates. The core keeps it
/// per account and per From address, so it is a display state only: it decides nothing about
/// which mail arrives. A row has none before the user unsubscribes, and again once that try was
/// undone or failed, so the UI offers the button again then.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(tag = "state", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum Unsubscribed {
    /// In the undo window until `until`. An `undo` naming `change` cancels it, and nothing has
    /// left the device. `method` is the way the core will try first: a one-click that fails its
    /// DKIM check goes out as mailto, or else leaves its page.
    Held {
        change: ChangeId,
        until: Time,
        method: UnsubscribeMethod,
    },
    /// Out of its window, and on its way by `method`. It can no longer be undone.
    Sending {
        change: ChangeId,
        method: UnsubscribeMethod,
    },
    /// Carried out by `method`, `one-click` or `mailto`: the sender's server took the POST, or
    /// the provider holds the email.
    Done {
        change: ChangeId,
        method: UnsubscribeMethod,
    },
    /// Only the sender's page is left: the message names no other way, or its one-click failed
    /// its DKIM check and there is no mailto the account can send. The core opens nothing. The
    /// UI offers "Open unsubscribe page" with `url`'s host, and opening it is the user's own
    /// action, through the shell's https-only `openExternal`. Whether the page unsubscribed is
    /// unknown, so it never becomes `done`.
    Page { change: ChangeId, url: String },
}
