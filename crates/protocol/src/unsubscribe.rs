//! Unsubscribing from a sender: what Updates shows of it, and the page a web unsubscribe opens.
//! The `unsubscribe` command (command.rs) starts one, and `undo` takes it back while it is held.

use serde::Serialize;
use ts_rs::TS;

use crate::{ChangeId, RequestId, Time};

/// How an unsubscribe goes out, or went out.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum UnsubscribeMethod {
    /// A POST of `List-Unsubscribe=One-Click` to the sender's URL, sent by the core (RFC 8058).
    OneClick,
    /// An email from the account to the sender's unsubscribe address, through the outbox.
    Mailto,
    /// The sender's page, opened in the system browser.
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
    /// DKIM check goes out as mailto, or else as web.
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
    /// Carried out by `method`: the sender's server took the POST, the provider holds the
    /// email, or the page was sent to the browser.
    Done {
        change: ChangeId,
        method: UnsubscribeMethod,
    },
}

/// A page the UI opens in the system browser, https only, in an `open-url` message.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(untagged)]
pub enum OpenUrl {
    /// A sign-in's consent page. The token goes to the core, never the UI.
    SignIn { id: RequestId, url: String },
    /// The page a web unsubscribe names, sent once its undo window ends. The change then settles `done`.
    Unsubscribe { change: ChangeId, url: String },
}
