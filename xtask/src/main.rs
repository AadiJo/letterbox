//! The repo's own tasks, in Rust. Run them through the cargo alias in .cargo/config.toml:
//!
//!   cargo xtask provider-names [path...]
//!
//! provider-names keeps provider vocabulary out of the core and the protocol. Both
//! must behave the same for every provider, so neither may name one in code or in a
//! string. Comments may. With no paths it checks crates/core/src and crates/protocol/src.
//! The words are in lint/provider-terms.txt. xtask/tests runs it over xtask/fixtures.

mod protocol_ts;
mod provider_names;

use std::path::{Path, PathBuf};
use std::process::ExitCode;

const USAGE: &str = "usage: cargo xtask provider-names [path...]\n       cargo xtask protocol-ts [--check]";

/// What provider-names checks when it is given no paths.
const CHECKED: [&str; 2] = ["crates/core/src", "crates/protocol/src"];

#[expect(
    clippy::disallowed_macros,
    reason = "a command-line tool reports on stdout and stderr"
)]
fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("xtask sits in the workspace folder");
    match args.next().as_deref() {
        Some("provider-names") => {}
        Some("protocol-ts") => return protocol_ts(workspace, args.next().as_deref() == Some("--check")),
        _ => {
            eprintln!("{USAGE}");
            return ExitCode::from(2);
        }
    }
    let given: Vec<PathBuf> = args.map(PathBuf::from).collect();
    let roots = if given.is_empty() {
        CHECKED.iter().map(|path| workspace.join(path)).collect()
    } else {
        given
    };

    let mut failed = false;
    for file in roots.iter().flat_map(|root| rust_files(root)) {
        let shown = file.strip_prefix(workspace).unwrap_or(&file).display();
        let findings = std::fs::read_to_string(&file)
            .map_err(|error| error.to_string())
            .and_then(|source| provider_names::find(&source).map_err(|error| error.to_string()));
        match findings {
            Err(error) => {
                eprintln!("{shown}: cannot read this as Rust: {error}");
                failed = true;
            }
            Ok(findings) => {
                for finding in findings {
                    println!(
                        "{shown}:{}: \"{}\" is provider vocabulary. The core and the protocol must behave the same \
                         for every provider, so do not name one here. If behaviour differs between providers, add \
                         a field to AdapterCapabilities in crates/core/src/adapter.rs and branch on it. If a \
                         provider knows a fact the core needs, add it to RemoteFacts and let the adapter fill it in.",
                        finding.line, finding.term
                    );
                    failed = true;
                }
            }
        }
    }
    if failed { ExitCode::FAILURE } else { ExitCode::SUCCESS }
}

/// Writes the TypeScript copy of the protocol, or with `check`, fails if the written copy differs.
#[expect(
    clippy::disallowed_macros,
    reason = "a command-line tool reports on stdout and stderr"
)]
fn protocol_ts(workspace: &Path, check: bool) -> ExitCode {
    let path = workspace.join(protocol_ts::PATH);
    let generated = protocol_ts::generate();
    if !check {
        return match std::fs::write(&path, generated) {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("{}: {error}", protocol_ts::PATH);
                ExitCode::FAILURE
            }
        };
    }
    if std::fs::read_to_string(&path).is_ok_and(|written| written == generated) {
        return ExitCode::SUCCESS;
    }
    eprintln!(
        "{} is out of date with crates/protocol. Run `cargo xtask protocol-ts` and commit the result. \
         Edit the Rust types, never the generated file.",
        protocol_ts::PATH
    );
    ExitCode::FAILURE
}

/// `path` if it is a file, else every .rs file under it, sorted.
fn rust_files(path: &Path) -> Vec<PathBuf> {
    if !path.is_dir() {
        return vec![path.to_owned()];
    }
    let mut entries: Vec<PathBuf> = std::fs::read_dir(path)
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok().map(|entry| entry.path()))
                .collect()
        })
        .unwrap_or_default();
    entries.sort();
    entries
        .into_iter()
        .flat_map(|entry| {
            if entry.is_dir() {
                rust_files(&entry)
            } else if entry.extension().is_some_and(|extension| extension == "rs") {
                vec![entry]
            } else {
                Vec::new()
            }
        })
        .collect()
}
