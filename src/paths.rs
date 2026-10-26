use std::path::{Component, Path, PathBuf};

pub fn assert_path_contained(target: &str, root: &Path) -> PathBuf {
    let abs_root = root.to_path_buf();
    let abs_target = abs_root.join(target);
    let rel = path_relative(&abs_root, &abs_target);
    if rel
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        panic!("Path outside sandbox root: {target}");
    }
    abs_target
}

fn path_relative(base: &Path, path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    let mut it_base = base.components().peekable();
    let mut it_path = path.components().peekable();
    while it_base.peek() == it_path.peek() {
        if it_base.peek().is_none() {
            break;
        }
        it_base.next();
        it_path.next();
    }
    for _ in it_base {
        out.push(Component::ParentDir);
    }
    for c in it_path {
        out.push(c);
    }
    out
}

fn collapse_whitespace_to_hyphen(s: &str) -> String {
    let mut out = String::new();
    let mut in_ws = false;
    for c in s.chars() {
        if c.is_whitespace() {
            if !in_ws && !out.is_empty() {
                out.push('-');
            }
            in_ws = true;
        } else {
            in_ws = false;
            out.push(c);
        }
    }
    out
}

pub fn branch_storage_slug(name: &str) -> Result<String, String> {
    let slug = collapse_whitespace_to_hyphen(
        &name
            .replace(['/', '\\'], "--")
            .replace([':', '*', '?', '"', '<', '>', '|'], "_"),
    )
        .trim_start_matches('.')
        .trim()
        .to_string();
    if slug.is_empty() {
        return Err(format!("Invalid branch name: {name}"));
    }
    Ok(slug)
}

pub fn pgcow_root(root: &Path) -> PathBuf {
    root.join(".pgcow")
}

pub fn branch_work_path(root: &Path, branch_name: &str) -> Result<PathBuf, String> {
    let slug = branch_storage_slug(branch_name)?;
    let path = pgcow_root(root).join("work").join(slug);
    assert_path_contained_path(&path, &pgcow_root(root));
    Ok(path)
}

pub fn branch_snapshot_path(root: &Path, branch_name: &str) -> Result<PathBuf, String> {
    let slug = branch_storage_slug(branch_name)?;
    let path = pgcow_root(root).join("snapshots").join(slug);
    assert_path_contained_path(&path, &pgcow_root(root));
    Ok(path)
}

fn assert_path_contained_path(path: &Path, root: &Path) {
    let rel = path_relative(root, path);
    if rel
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        panic!("Path outside sandbox root: {}", path.display());
    }
}

pub fn is_reparse_point(data_dir: &Path) -> bool {
    let meta = std::fs::symlink_metadata(data_dir);
    match meta {
        Ok(m) => {
            if m.file_type().is_symlink() {
                return true;
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
                return m.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0;
            }
            #[cfg(not(windows))]
            false
        }
        Err(_) => false,
    }
}

pub fn same_resolved_path(a: &Path, b: &Path) -> bool {
    let ra = std::fs::canonicalize(a);
    let rb = std::fs::canonicalize(b);
    match (ra, rb) {
        (Ok(pa), Ok(pb)) => pa == pb,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugifies_git_branch_names() {
        assert_eq!(branch_storage_slug("feat/x").unwrap(), "feat--x");
    }

    #[test]
    fn rejects_empty_slug() {
        assert!(branch_storage_slug("   ").is_err());
    }
}
