//! Writes the TypeScript copy of the protocol from crates/protocol, so the Rust types
//! are the only ones anyone writes by hand.

use letterbox_protocol::*;
use ts_rs::{Config, TS};

/// Where the TypeScript copy goes, from the workspace folder.
pub const PATH: &str = "packages/protocol/src/generated.ts";

const HEADER: &str = "// Generated from crates/protocol/src/lib.rs by `cargo xtask protocol-ts`. Do not edit.
// Change the Rust types and run that command. `pnpm check` fails while this file is stale.

declare const brand: unique symbol
/** An opaque string. A client passes on the ids it was sent and never builds or parses one. */
export type Id<Name extends string> = string & { readonly [brand]: Name }
";

/// The whole file, with every protocol type in declaration order.
pub fn generate() -> String {
    // Revisions, counts and sizes stay far below 2^53, so they are plain numbers in JavaScript.
    let config = Config::new().with_large_int("number");
    let mut out = format!("{HEADER}\nexport const PROTOCOL = {PROTOCOL}\n");
    macro_rules! declare {
        ($($ty:ty),* $(,)?) => {$(
            out.push('\n');
            if let Some(docs) = <$ty as TS>::docs() {
                out.push_str(&docs);
            }
            out.push_str("export ");
            out.push_str(&<$ty as TS>::decl(&config));
            out.push('\n');
        )*};
    }
    declare!(
        AccountId, MailboxId, ThreadId, MessageId, BlobId, SignInOptionId, SubscriptionId, ChangeId, RequestId,
        Account, Capabilities, AccountStatus, AccountErrorReason, Mailbox, Role, Person, Turn, TurnReason, TurnState,
        ThreadSummary, ThreadDetail, Message, Body, Unavailable, Images, ShowImages, Tracker, TrackerReason, Quote,
        Unsubscribe, UnsubscribeSource, ImageFile, ImageError, Colors, ColorScheme, HtmlLook, Swatch, ColorRole,
        Attachment, Unsubscribed, UnsubscribeMethod,
        ThreadFilter, Query, Update, ThreadPage, SenderId, SenderSummary, SenderDay, SenderPage, Recipient, ChangeHolder,
        Command, TurnChoice, Draft, Delivery, Refusal, ChangeResult, UndoConflict, UndoField,
        SignInOption, SignInMethod, Request, PasswordInput, Response, Answer<Empty, Never>, True, False, Empty, Never,
        SignedIn, SignInError, SyncNowError, BlobUrl, BlobError, AttachmentFile, AttachmentError, Position,
        ClientMessage, CoreMessage, YourTurn, ProtocolErrorReason,
    );
    out
}
