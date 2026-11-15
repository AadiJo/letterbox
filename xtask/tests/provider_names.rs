//! Runs the real `xtask provider-names` program over the fixtures in xtask/fixtures,
//! the way `cargo xtask provider-names` runs over the crates. Each fixture file
//! lists the ways the check could fail on it.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn workspace() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("xtask sits in the workspace folder")
}

fn fixtures(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures").join(name)
}

fn provider_names(path: &Path) -> Output {
    Command::new(env!("CARGO_BIN_EXE_xtask"))
        .arg("provider-names")
        .arg(path)
        .output()
        .expect("the xtask program runs")
}

/// Every .rs file under `folder`, sorted.
fn rust_files(folder: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for entry in std::fs::read_dir(folder).expect("the fixture folder exists") {
        let path = entry.expect("the fixture folder can be listed").path();
        if path.is_dir() {
            files.extend(rust_files(&path));
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            files.push(path);
        }
    }
    files.sort();
    files
}

/// "path:line" for every line under `folder` that ends in a `// flagged` marker, as the program prints it.
fn marked_lines(folder: &Path) -> Vec<String> {
    let mut marked = Vec::new();
    for file in rust_files(folder) {
        let shown = file
            .strip_prefix(workspace())
            .expect("fixtures are inside the workspace");
        let text = std::fs::read_to_string(&file).expect("a fixture can be read");
        for (index, line) in text.lines().enumerate() {
            if line.trim_end().ends_with("// flagged") {
                marked.push(format!("{}:{}", shown.display(), index + 1));
            }
        }
    }
    marked
}

#[test]
fn reports_every_marked_line_and_no_other() {
    let folder = fixtures("provider-names");
    let output = provider_names(&folder);
    let stdout = String::from_utf8(output.stdout).expect("the report is text");
    let mut reported: Vec<String> = stdout
        .lines()
        .map(|line| line.split(": ").next().unwrap_or(line).to_owned())
        .collect();
    reported.sort();

    let mut expected = marked_lines(&folder);
    expected.sort();
    assert!(!expected.is_empty(), "the fixtures mark at least one line");
    assert_eq!(reported, expected, "full report:\n{stdout}");
    assert!(
        !output.status.success(),
        "the program exits with failure when it reports a name"
    );
}

#[test]
fn fails_on_a_file_it_cannot_read_as_rust() {
    let output = provider_names(&fixtures("unreadable"));
    let stderr = String::from_utf8(output.stderr).expect("the error is text");
    assert!(!output.status.success(), "an unreadable file is a failure, not a pass");
    assert!(stderr.contains("broken.rs"), "the error names the file: {stderr}");
}
