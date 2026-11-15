//! Keeps hand-written source files short enough to read whole. Every .rs and .ts file
//! git tracks must stay at or under `LIMIT` lines, except the ones listed in the
//! baseline, which may only shrink: each listed number must equal its file's length,
//! and no number may be added or raised compared with the accepted baseline. The
//! accepted baseline is the one at git revision FILE_SIZE_BASE (CI sets it to a pull
//! request's base), or at HEAD when that is unset, as in the pre-commit hook.

use std::collections::BTreeMap;
use std::fmt;
use std::path::Path;
use std::process::Command;

/// The most lines a hand-written file may have. 500 is about what a reader holds in
/// mind at once, and every file here but two was under 400 when the check arrived.
pub const LIMIT: usize = 500;

/// Files that were over `LIMIT` when the check arrived, each with its length then.
pub const BASELINE: &str = "xtask/file-size-baseline.txt";

/// Tracked files no person writes or reads as code: the generated protocol copy...
const GENERATED: [&str; 1] = ["packages/protocol/src/generated.ts"];
/// ...and the folders of test input.
const FIXTURE_FOLDERS: [&str; 2] = ["lint/fixtures/", "xtask/fixtures/"];

/// One file that breaks the rule.
pub enum Problem {
    /// A file not in the baseline is over the limit.
    OverLimit { path: String, lines: usize },
    /// A baselined file is longer than its recorded length.
    Grew {
        path: String,
        lines: usize,
        recorded: usize,
    },
    /// A baselined file is shorter than its recorded length, so the number should come down.
    Shrank {
        path: String,
        lines: usize,
        recorded: usize,
    },
    /// A baselined file is at or under the limit now, or gone, and its line should go.
    Stale { path: String, lines: Option<usize> },
    /// The baseline lists a file the accepted baseline does not.
    Added { path: String, base: String },
    /// The baseline records a larger number for a file than the accepted baseline does.
    Raised {
        path: String,
        recorded: usize,
        accepted: usize,
    },
}

impl fmt::Display for Problem {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        const SPLIT: &str = "Split it by responsibility: move each part that does one job into a file of \
                             its own. Never raise the limit or add to the baseline.";
        match self {
            Problem::OverLimit { path, lines } => {
                write!(f, "{path}: {lines} lines, over the limit of {LIMIT}. {SPLIT}")
            }
            Problem::Grew { path, lines, recorded } => write!(
                f,
                "{path}: {lines} lines, up from {recorded} in {BASELINE}. A file over the limit of {LIMIT} \
                 may only shrink. {SPLIT}"
            ),
            Problem::Shrank { path, lines, recorded } => write!(
                f,
                "{path}: {lines} lines, down from {recorded}. Lower its number in {BASELINE} to {lines}, so \
                 it cannot grow back."
            ),
            Problem::Added { path, base } => write!(
                f,
                "{path}: listed in {BASELINE}, but not in the accepted baseline at {base}. Never add a file to \
                 the baseline. Remove its line and split the file by responsibility: move each part that does \
                 one job into a file of its own."
            ),
            Problem::Raised {
                path,
                recorded,
                accepted,
            } => write!(
                f,
                "{path}: recorded as {recorded} lines in {BASELINE}, but {accepted} in the accepted baseline. \
                 Numbers in the baseline may only go down. Put back {accepted} and split the file by \
                 responsibility."
            ),
            Problem::Stale {
                path,
                lines: Some(lines),
            } => write!(
                f,
                "{path}: {lines} lines, within the limit of {LIMIT}. Remove its line from {BASELINE}, so the \
                 limit holds it from now on."
            ),
            Problem::Stale { path, lines: None } => write!(
                f,
                "{path}: listed in {BASELINE}, but it is no longer a tracked .rs or .ts file. Remove its line \
                 from {BASELINE}."
            ),
        }
    }
}

/// Every problem under `root`, a git checkout, ordered by path.
pub fn check(root: &Path) -> Result<Vec<Problem>, String> {
    let mut recorded = baseline(root)?;
    let mut problems = Vec::new();
    if let Some((base, accepted)) = accepted(root)? {
        for (path, &lines) in &recorded {
            match accepted.get(path) {
                None => problems.push(Problem::Added {
                    path: path.clone(),
                    base: base.clone(),
                }),
                Some(&before) if lines > before => problems.push(Problem::Raised {
                    path: path.clone(),
                    recorded: lines,
                    accepted: before,
                }),
                Some(_) => {}
            }
        }
    }
    for path in tracked(root)? {
        let Some(lines) = length(&root.join(&path))? else {
            continue;
        };
        match recorded.remove(&path) {
            None if lines > LIMIT => problems.push(Problem::OverLimit { path, lines }),
            None => {}
            Some(_) if lines <= LIMIT => problems.push(Problem::Stale {
                path,
                lines: Some(lines),
            }),
            Some(recorded) if lines > recorded => problems.push(Problem::Grew { path, lines, recorded }),
            Some(recorded) if lines < recorded => problems.push(Problem::Shrank { path, lines, recorded }),
            Some(_) => {}
        }
    }
    problems.extend(recorded.into_keys().map(|path| Problem::Stale { path, lines: None }));
    problems.sort_by(|a, b| a.path().cmp(b.path()));
    Ok(problems)
}

impl Problem {
    fn path(&self) -> &str {
        match self {
            Problem::OverLimit { path, .. }
            | Problem::Grew { path, .. }
            | Problem::Shrank { path, .. }
            | Problem::Stale { path, .. }
            | Problem::Added { path, .. }
            | Problem::Raised { path, .. } => path,
        }
    }
}

/// Baseline entries: each path and its recorded length.
type Entries = BTreeMap<String, usize>;

/// The baseline's entries, path to recorded length. Each line is `<lines> <path>`.
/// Blank lines and lines that start with `#` are skipped. A missing baseline is empty.
fn baseline(root: &Path) -> Result<Entries, String> {
    match std::fs::read_to_string(root.join(BASELINE)) {
        Ok(text) => parse(&text, BASELINE),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(error) => Err(format!("{BASELINE}: {error}")),
    }
}

/// The accepted baseline and the revision it was read at. None when there is nothing to
/// compare with: HEAD does not exist yet, or the baseline did not exist at the revision.
/// A FILE_SIZE_BASE this checkout lacks is an error, since passing would skip the check.
fn accepted(root: &Path) -> Result<Option<(String, Entries)>, String> {
    let given = std::env::var("FILE_SIZE_BASE").ok().filter(|base| !base.is_empty());
    let base = given.clone().unwrap_or_else(|| "HEAD".to_owned());
    let exists = |spec: &str| git(root, &["cat-file", "-e", spec]).map(|output| output.status.success());
    if !exists(&format!("{base}^{{commit}}"))? {
        return match given {
            Some(base) => Err(format!(
                "FILE_SIZE_BASE is {base}, which this checkout does not have. Fetch it first, for example \
                 `git fetch --depth=1 origin {base}`."
            )),
            None => Ok(None),
        };
    }
    let spec = format!("{base}:{BASELINE}");
    if !exists(&spec)? {
        return Ok(None);
    }
    let output = git(root, &["show", &spec])?;
    let text = String::from_utf8(output.stdout).map_err(|error| format!("{spec} is not UTF-8: {error}"))?;
    Ok(Some((base, parse(&text, &spec)?)))
}

/// Reads baseline text, where each line is `<lines> <path>`. `name` says where it came from.
fn parse(text: &str, name: &str) -> Result<Entries, String> {
    let mut entries = BTreeMap::new();
    for (index, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let entry = line
            .split_once(' ')
            .and_then(|(lines, path)| Some((path.trim().to_owned(), lines.parse().ok()?)));
        let Some((path, lines)) = entry.filter(|(path, _)| !path.is_empty()) else {
            return Err(format!(
                "{name}:{}: cannot read \"{line}\". Each line is `<lines> <path>`, such as `1202 \
                 packages/sim-provider/src/selfcheck.ts`.",
                index + 1
            ));
        };
        entries.insert(path, lines);
    }
    Ok(entries)
}

/// Runs git in `root`. A git hook exports GIT_DIR and GIT_INDEX_FILE for its own
/// repository. Dropped, git finds the repository from `root`, which is the one this
/// check was asked about.
fn git(root: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    let mut command = Command::new("git");
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
    command
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|error| format!("cannot run git: {error}"))
}

/// Every .rs and .ts file git tracks under `root`, relative to it, minus `GENERATED` and `FIXTURE_FOLDERS`.
fn tracked(root: &Path) -> Result<Vec<String>, String> {
    let output = git(root, &["ls-files", "-z", "--", "*.rs", "*.ts"])?;
    if !output.status.success() {
        return Err(format!(
            "git ls-files failed in {}: {}",
            root.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let listed =
        String::from_utf8(output.stdout).map_err(|error| format!("git listed a path that is not UTF-8: {error}"))?;
    Ok(listed
        .split('\0')
        .filter(|path| {
            !path.is_empty()
                && !GENERATED.contains(path)
                && !FIXTURE_FOLDERS.iter().any(|folder| path.starts_with(folder))
        })
        .map(str::to_owned)
        .collect())
}

/// How many lines the file has, or `None` if it was deleted but not yet from git.
fn length(path: &Path) -> Result<Option<usize>, String> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).lines().count())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("{}: {error}", path.display())),
    }
}
