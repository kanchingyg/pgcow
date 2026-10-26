use std::path::Path;
use std::process::Command;

use crate::branch_store::{create_branch, read_meta, switch_branch};

pub fn current_git_branch(cwd: &Path) -> Option<String> {
    let output = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(cwd)
        .output();
    match output {
        Ok(o) if o.status.success() => {
            let name = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if name.is_empty() || name == "HEAD" {
                None
            } else {
                Some(name)
            }
        }
        _ => None,
    }
}

pub struct SyncGitResult {
    pub branch: String,
    pub created: bool,
}

pub fn sync_db_branch_from_git(
    root: &Path,
    allow_write: bool,
    cwd: Option<&Path>,
    dry_run: bool,
    git_branch: Option<&str>,
) -> Result<SyncGitResult, String> {
    let cwd = cwd.unwrap_or(root);
    let git_branch = match git_branch {
        Some(b) => b.to_string(),
        None => current_git_branch(cwd).ok_or("Not a git repository or detached HEAD")?,
    };

    let meta = read_meta(root).ok_or("pgcow store not initialized")?;
    let exists = meta.branches.contains_key(&git_branch);

    if dry_run {
        return Ok(SyncGitResult {
            branch: git_branch,
            created: !exists,
        });
    }

    if exists {
        switch_branch(root, &git_branch, false)?;
        return Ok(SyncGitResult {
            branch: git_branch,
            created: false,
        });
    }

    if !allow_write {
        return Err(format!(
            "No DB branch for git '{git_branch}'. Use --allow-write to create."
        ));
    }

    let active = meta.active.clone();
    create_branch(root, &git_branch, Some(&active), false, true)?;
    switch_branch(root, &git_branch, false)?;
    Ok(SyncGitResult {
        branch: git_branch,
        created: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::branch_store::ensure_store;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_test_dir(prefix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("{}-{}", prefix, nanos));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn sync_git_dry_run_no_work_dir() {
        let root_path = temp_test_dir("pgcow-sync");
        let data_dir = root_path.join("pgdata");
        fs::create_dir_all(&data_dir).unwrap();
        fs::write(data_dir.join("data.txt"), "main\n").unwrap();
        ensure_store(&root_path, &data_dir).unwrap();

        let res = sync_db_branch_from_git(
            &root_path,
            false,
            None,
            true,
            Some("new/branch"),
        )
        .unwrap();
        assert!(res.created);
        assert!(!root_path.join(".pgcow/work/new--branch").exists());
    }
}
