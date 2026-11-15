//! Runs the real `xtask file-size` program over the cases in xtask/fixtures/file-size,
//! the way `cargo xtask file-size` runs over the repo. Each case is copied into a fresh
//! git repository first, since the check covers only files git tracks. Each fixture file
//! lists the ways the check could fail on it.
//!
//! Fixture files stay short. A `// pad to N lines` line asks for the copy to be padded
//! to N lines, so the planted file has the length the case needs. Files named
//! `untracked*` are copied but never added to git.
//!
//! `pnpm check:rust` runs these tests from the pre-commit hook, and a hook exports
//! GIT_DIR, GIT_INDEX_FILE and more for the repository being committed. Every git call
//! here drops them, or `git init` and `git add` would write to that repository.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

/// The lines a fixture asks to be padded to, if it does.
fn padded_length(text: &str) -> Option<usize> {
    text.lines().find_map(|line| {
        line.trim()
            .strip_prefix("// pad to ")?
            .strip_suffix(" lines")?
            .parse()
            .ok()
    })
}

/// Copies every file under `from` into `to`, padding the ones that ask for it.
fn plant(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).expect("the case folder can be made");
    for entry in std::fs::read_dir(from).expect("the fixture folder exists") {
        let path = entry.expect("the fixture folder can be listed").path();
        let target = to.join(path.file_name().expect("a listed entry has a name"));
        if path.is_dir() {
            plant(&path, &target);
            continue;
        }
        let mut text = std::fs::read_to_string(&path).expect("a fixture can be read");
        if let Some(length) = padded_length(&text) {
            let filler = length
                .checked_sub(text.lines().count())
                .expect("a fixture is shorter than the length it asks for");
            text.push_str(&"// filler\n".repeat(filler));
        }
        std::fs::write(&target, text).expect("a planted file can be written");
    }
}

/// A command that does not inherit the GIT_* variables a git hook exports.
fn without_git_variables(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
    command
}

/// Runs git in `root` and returns what it printed.
fn git(root: &Path, args: &[&str]) -> String {
    let output = without_git_variables("git")
        .args(args)
        .current_dir(root)
        .output()
        .expect("git runs");
    assert!(output.status.success(), "git {args:?} failed in {}", root.display());
    String::from_utf8(output.stdout).expect("git prints text")
}

/// A fresh git repository holding the case `name`, with every file but `untracked*` added.
fn repository(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("letterbox-file-size-{}-{name}", std::process::id()));
    // A folder left by an earlier run with the same process id would mix in its files.
    let _ = std::fs::remove_dir_all(&root);
    let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/file-size");
    plant(&fixtures.join(name), &root);
    git(&root, &["init", "--quiet"]);
    git(&root, &["add", "--all", "--", ".", ":(exclude,glob)**/untracked*"]);
    root
}

/// Runs the program on `root` with GIT_DIR pointing at this workspace's repository, as
/// it does inside a git hook. It must still check `root`, not the workspace.
fn file_size(root: &Path) -> Output {
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR"));
    let git_dir = git(workspace, &["rev-parse", "--absolute-git-dir"]);
    let output = without_git_variables(env!("CARGO_BIN_EXE_xtask"))
        .env("GIT_DIR", git_dir.trim())
        .arg("file-size")
        .arg(root)
        .output()
        .expect("the xtask program runs");
    std::fs::remove_dir_all(root).expect("the case folder can be removed");
    output
}

#[test]
fn passes_files_at_the_limit_skipped_or_shrinking() {
    let output = file_size(&repository("pass"));
    let stdout = String::from_utf8(output.stdout).expect("the report is text");
    let stderr = String::from_utf8(output.stderr).expect("the error is text");
    assert!(output.status.success(), "stdout:\n{stdout}\nstderr:\n{stderr}");
    assert_eq!(stdout, "", "a passing run reports nothing");
}

#[test]
fn reports_each_problem_once_and_says_what_to_do_instead() {
    let output = file_size(&repository("fail"));
    let stdout = String::from_utf8(output.stdout).expect("the report is text");
    let mut reported: Vec<&str> = stdout
        .lines()
        .map(|line| line.split(": ").next().unwrap_or(line))
        .collect();
    reported.sort_unstable();
    assert_eq!(
        reported,
        ["dropped.ts", "gone.rs", "grew.rs", "nested/new.ts", "new.rs"],
        "full report:\n{stdout}"
    );
    assert!(
        !output.status.success(),
        "the program exits with failure when it reports a file"
    );

    for line in stdout.lines() {
        let path = line.split(": ").next().unwrap_or(line);
        let advice = match path {
            "new.rs" | "nested/new.ts" | "grew.rs" => "Split it by responsibility",
            _ => "Remove its line from xtask/file-size-baseline.txt",
        };
        assert!(line.contains(advice), "the report for {path} says what to do: {line}");
        assert!(
            !line.contains("Split") || line.contains("Never raise the limit or add to the baseline"),
            "the report for {path} rules out the shortcuts: {line}"
        );
    }
}

#[test]
fn fails_on_a_baseline_it_cannot_read() {
    let output = file_size(&repository("unreadable-baseline"));
    let stderr = String::from_utf8(output.stderr).expect("the error is text");
    assert!(
        !output.status.success(),
        "an unreadable baseline is a failure, not a pass"
    );
    assert!(
        stderr.contains("xtask/file-size-baseline.txt:4"),
        "the error names the baseline and the line: {stderr}"
    );
}
