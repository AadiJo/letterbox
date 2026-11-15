//! Keeps hand-written source files short enough to read whole. Every .rs and .ts file
//! git tracks must stay at or under `LIMIT` lines, except the ones listed in the
//! baseline, which may only shrink.

use std::collections::BTreeMap;
use std::fmt;
use std::path::Path;
use std::process::Command;

/// The most lines a hand-written file may have. 500 is about what a reader holds in
/// mind at once, and every file here but two was under 400 when the check arrived.
pub const LIMIT: usize = 500;

/// Files that were over `LIMIT` when the check arrived, each with its length then.
pub const BASELINE: &str = "xtask/file-size-baseline.txt";

/// Tracked files no person writes or reads as code: the generated protocol copy and test input.
const SKIPPED: [&str; 3] = [
    "packages/protocol/src/generated.ts",
    "lint/fixtures/",
    "xtask/fixtures/",
];

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
    /// A baselined file is at or under the limit now, or gone, and its line should go.
    Stale { path: String, lines: Option<usize> },
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
            Problem::OverLimit { path, .. } | Problem::Grew { path, .. } | Problem::Stale { path, .. } => path,
        }
    }
}

/// The baseline's entries, path to recorded length. Each line is `<lines> <path>`.
/// Blank lines and lines that start with `#` are skipped. A missing baseline is empty.
fn baseline(root: &Path) -> Result<BTreeMap<String, usize>, String> {
    let text = match std::fs::read_to_string(root.join(BASELINE)) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(error) => return Err(format!("{BASELINE}: {error}")),
    };
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
                "{BASELINE}:{}: cannot read \"{line}\". Each line is `<lines> <path>`, such as `1202 \
                 packages/sim-provider/src/selfcheck.ts`.",
                index + 1
            ));
        };
        entries.insert(path, lines);
    }
    Ok(entries)
}

/// Every .rs and .ts file git tracks under `root`, relative to it, minus `SKIPPED`.
fn tracked(root: &Path) -> Result<Vec<String>, String> {
    let mut command = Command::new("git");
    // A git hook exports GIT_DIR and GIT_INDEX_FILE for its own repository. Dropped, git
    // finds the repository from `root`, which is the one this check was asked about.
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
    let output = command
        .args(["ls-files", "-z", "--", "*.rs", "*.ts"])
        .current_dir(root)
        .output()
        .map_err(|error| format!("cannot run git: {error}"))?;
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
        .filter(|path| !path.is_empty() && !SKIPPED.iter().any(|skipped| path.starts_with(skipped)))
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
