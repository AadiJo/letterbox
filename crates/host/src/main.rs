//! The core as the desktop app runs it, with the wall clock, the system keychain and Gmail:
//!
//!   letterbox-core --data <folder> --gmail-client <file>
//!
//! `<file>` is the JSON Google Cloud Console downloads for an OAuth client of type
//! "Desktop app". The client id and secret come only from it, never from the repo.
//! The Electron app spawns this program and speaks the protocol over its stdin and
//! stdout, one JSON message per line, the same way the scenarios drive `core-sim`.

use std::fmt;
use std::path::PathBuf;
use std::process::ExitCode;

use letterbox_host::{GmailClient, app_parts, run_stdio};
use serde::Deserialize;

const USAGE: &str = "usage: letterbox-core --data <folder> --gmail-client <file>\n  \
    <file> is the JSON Google Cloud Console downloads for an OAuth client of type Desktop app";

/// What the command line asked for, before the client file is read.
struct Args {
    data: PathBuf,
    gmail_client: PathBuf,
}

/// Why the program cannot start. Each one is shown with the usage and exits with 2.
enum StartError {
    UnknownFlag(String),
    NoValue(&'static str),
    Repeated(&'static str),
    Missing(&'static str),
    ClientFile(PathBuf, ClientFileError),
}

/// What is wrong with the `--gmail-client` file.
enum ClientFileError {
    Read(std::io::Error),
    Json(serde_json::Error),
    NotDesktop,
    NoClientId,
}

impl fmt::Display for StartError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StartError::UnknownFlag(flag) => write!(f, "unknown argument {flag:?}"),
            StartError::NoValue(flag) => write!(f, "{flag} needs a value"),
            StartError::Repeated(flag) => write!(f, "{flag} is given more than once"),
            StartError::Missing(flag) => write!(f, "{flag} is required"),
            StartError::ClientFile(path, error) => write!(f, "--gmail-client {}: {error}", path.display()),
        }
    }
}

impl fmt::Display for ClientFileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ClientFileError::Read(error) => write!(f, "cannot read it: {error}"),
            ClientFileError::Json(error) => write!(f, "it is not an OAuth client file: {error}"),
            ClientFileError::NotDesktop => write!(
                f,
                "it has no \"installed\" client. Download the JSON of an OAuth client of type Desktop app"
            ),
            ClientFileError::NoClientId => write!(f, "its \"installed.client_id\" is empty"),
        }
    }
}

/// The parts of Google's client file that a sign-in needs. Google writes more fields.
#[derive(Deserialize)]
struct ClientFile {
    installed: Option<Installed>,
}

#[derive(Deserialize)]
struct Installed {
    #[serde(default)]
    client_id: String,
    client_secret: Option<String>,
}

/// Reads each `--flag value` pair. Every flag is required and given once.
fn parse_args(mut args: impl Iterator<Item = String>) -> Result<Args, StartError> {
    let mut data = None;
    let mut gmail_client = None;
    while let Some(flag) = args.next() {
        let (name, slot) = match flag.as_str() {
            "--data" => ("--data", &mut data),
            "--gmail-client" => ("--gmail-client", &mut gmail_client),
            _ => return Err(StartError::UnknownFlag(flag)),
        };
        let value = args.next().ok_or(StartError::NoValue(name))?;
        if slot.replace(PathBuf::from(value)).is_some() {
            return Err(StartError::Repeated(name));
        }
    }
    Ok(Args {
        data: data.ok_or(StartError::Missing("--data"))?,
        gmail_client: gmail_client.ok_or(StartError::Missing("--gmail-client"))?,
    })
}

/// Reads the client id and secret from Google's client file.
fn read_client(path: &PathBuf) -> Result<GmailClient, ClientFileError> {
    let text = std::fs::read_to_string(path).map_err(ClientFileError::Read)?;
    let file: ClientFile = serde_json::from_str(&text).map_err(ClientFileError::Json)?;
    let installed = file.installed.ok_or(ClientFileError::NotDesktop)?;
    if installed.client_id.is_empty() {
        return Err(ClientFileError::NoClientId);
    }
    Ok(GmailClient {
        id: installed.client_id,
        secret: installed.client_secret.filter(|secret| !secret.is_empty()),
    })
}

/// The data folder and the Gmail client, or why the program cannot start.
fn start() -> Result<(PathBuf, GmailClient), StartError> {
    let args = parse_args(std::env::args().skip(1))?;
    let client = read_client(&args.gmail_client).map_err(|error| StartError::ClientFile(args.gmail_client, error))?;
    Ok((args.data, client))
}

#[expect(
    clippy::disallowed_macros,
    reason = "a program that cannot start says why on stderr. The protocol has not begun"
)]
fn main() -> ExitCode {
    match start() {
        Ok((data, client)) => match app_parts(data, client) {
            Ok(parts) => run_stdio("letterbox-core", parts),
            Err(error) => {
                eprintln!("letterbox-core: {error}");
                ExitCode::FAILURE
            }
        },
        Err(error) => {
            eprintln!("letterbox-core: {error}\n{USAGE}");
            ExitCode::from(2)
        }
    }
}
