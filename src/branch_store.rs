use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::cow_engine::{cow_clone_dir, CowMethod};
use crate::paths::{
    branch_snapshot_path, branch_storage_slug, branch_work_path, is_reparse_point,
    same_resolved_path,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BranchEntry {
    pub work: String,
    pub snapshot: String,
    #[serde(default)]
    pub slug: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BranchMeta {
    pub data_dir: String,
    pub active: String,
    pub branches: std::collections::BTreeMap<String, BranchEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embed_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embed_dim: Option<u32>,
}

const META_FILE: &str = "meta.json";

pub fn meta_path(root: &Path) -> PathBuf {
    root.join(".pgcow").join(META_FILE)
}

pub fn read_meta(root: &Path) -> Option<BranchMeta> {
    let p = meta_path(root);
    if !p.exists() {
        return None;
    }
    let raw = fs::read_to_string(&p).ok()?;
    let mut meta: BranchMeta = serde_json::from_str(&raw).ok()?;
    for (name, branch) in meta.branches.iter_mut() {
        if branch.slug.is_empty() {
            branch.slug = branch_storage_slug(name).unwrap_or_default();
        }
    }
    Some(meta)
}

pub fn write_meta(root: &Path, meta: &BranchMeta) -> Result<(), String> {
    let dir = root.join(".pgcow");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
    fs::write(meta_path(root), json).map_err(|e| e.to_string())?;
    Ok(())
}

fn slug_collision(meta: &BranchMeta, name: &str) -> Result<(), String> {
    let slug = branch_storage_slug(name)?;
    for (existing, branch) in &meta.branches {
        if existing != name && branch.slug == slug {
            return Err(format!(
                "Branch slug collision: '{}' and '{}' both map to '{}'",
                name,
                existing,
                slug
            ));
        }
    }
    Ok(())
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<(), String> {
    if !src.exists() {
        return Ok(());
    }
    fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let s = entry.path();
        let d = dest.join(entry.file_name());
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            copy_dir_recursive(&s, &d)?;
        } else {
            fs::copy(&s, &d).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub fn persist_data_dir_to_branch(meta: &BranchMeta, branch_name: &str) {
    let branch = meta.branches.get(branch_name);
    if branch.is_none() {
        return;
    }
    let branch = branch.unwrap();
    let data_dir = PathBuf::from(&meta.data_dir);
    let work = PathBuf::from(&branch.work);
    if !data_dir.exists() || is_reparse_point(&data_dir) {
        return;
    }
    if same_resolved_path(&data_dir, &work) {
        return;
    }
    let _ = copy_dir_recursive(&data_dir, &work);
}

#[cfg(unix)]
fn symlink_dir(target: &Path, link: &Path) -> Result<(), String> {
    std::os::unix::fs::symlink(target, link).map_err(|e| e.to_string())
}

#[cfg(not(unix))]
fn symlink_dir(_target: &Path, _link: &Path) -> Result<(), String> {
    Err("symlink_dir is only supported on unix".into())
}

fn remove_link_path(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    if cfg!(windows) && is_reparse_point(path) {
        let arg = path.to_string_lossy().replace('/', "\\");
        let status = Command::new("cmd")
            .args(["/C", "rmdir", &arg])
            .status()
            .map_err(|e| e.to_string())?;
        if status.success() {
            return Ok(());
        }
    }
    if path.is_symlink() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    } else {
        fs::remove_dir_all(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn create_dir_link(target: &Path, link: &Path) -> Result<(), String> {
    if let Some(parent) = link.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if link.exists() {
        fs::remove_dir_all(link).or_else(|_| fs::remove_file(link)).map_err(|e| e.to_string())?;
    }
    if cfg!(windows) {
        let target = std::fs::canonicalize(target).map_err(|e| e.to_string())?;
        let link_parent = link
            .parent()
            .ok_or_else(|| "link path has no parent".to_string())?;
        fs::create_dir_all(link_parent).map_err(|e| e.to_string())?;
        let link_arg = link.to_string_lossy().replace('/', "\\");
        let target_arg = target.to_string_lossy().replace('/', "\\");
        let status = Command::new("cmd")
            .args(["/C", "mklink", "/J", &link_arg, &target_arg])
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(format!(
                "mklink /J failed for {} -> {}",
                link.display(),
                target.display()
            ));
        }
    } else {
        symlink_dir(target, link)?;
    }
    Ok(())
}

pub fn activate_branch_data_dir(meta: &BranchMeta) -> Result<(), String> {
    let branch = meta
        .branches
        .get(&meta.active)
        .ok_or_else(|| format!("Unknown active branch: {}", meta.active))?;

    let data_dir = PathBuf::from(&meta.data_dir);
    let work = PathBuf::from(&branch.work);

    if data_dir.exists() && same_resolved_path(&data_dir, &work) {
        return Ok(());
    }

    if data_dir.exists() {
        remove_link_path(&data_dir)?;
    }

    create_dir_link(&work, &data_dir)?;
    Ok(())
}

pub fn sync_active_data_dir(meta: &BranchMeta) -> Result<(), String> {
    activate_branch_data_dir(meta)
}

pub fn ensure_store(root: &Path, data_dir: &Path) -> Result<BranchMeta, String> {
    if let Some(existing) = read_meta(root) {
        return Ok(existing);
    }

    let work_main = branch_work_path(root, "main")?;
    let snap_main = branch_snapshot_path(root, "main")?;
    fs::create_dir_all(&work_main).map_err(|e| e.to_string())?;

    if data_dir.exists() && !is_reparse_point(data_dir) {
        copy_dir_recursive(data_dir, &work_main)?;
    }
    fs::create_dir_all(&snap_main).map_err(|e| e.to_string())?;
    copy_dir_recursive(&work_main, &snap_main)?;

    let slug = branch_storage_slug("main")?;
    let meta = BranchMeta {
        data_dir: data_dir.to_string_lossy().into_owned(),
        active: "main".into(),
        branches: [(
            "main".into(),
            BranchEntry {
                work: work_main.to_string_lossy().into_owned(),
                snapshot: snap_main.to_string_lossy().into_owned(),
                slug,
            },
        )]
        .into_iter()
        .collect(),
        embed_dir: None,
        embed_dim: None,
    };
    write_meta(root, &meta)?;
    sync_active_data_dir(&meta)?;
    Ok(meta)
}

pub fn dsn_for(data_dir: &str) -> String {
    let normalized = data_dir.replace('\\', "/");
    format!("sqlite://{}/main.db", normalized.trim_end_matches('/'))
}

pub struct CreateBranchResult {
    pub dsn: String,
    pub method: Option<CowMethod>,
    pub elapsed_ms: Option<f64>,
}

pub fn create_branch(
    root: &Path,
    name: &str,
    from: Option<&str>,
    dry_run: bool,
    allow_write: bool,
) -> Result<CreateBranchResult, String> {
    if !allow_write && !dry_run {
        return Err("Read-only: pass --allow-write to create branches.".into());
    }
    let meta = read_meta(root).ok_or("Store not initialized")?;
    if meta.branches.contains_key(name) {
        return Err(format!("Branch exists: {name}"));
    }
    slug_collision(&meta, name)?;

    let source = from.unwrap_or(&meta.active);
    let src_branch = meta
        .branches
        .get(source)
        .ok_or_else(|| format!("Source branch missing: {source}"))?;

    let work = branch_work_path(root, name)?;
    let snapshot = branch_snapshot_path(root, name)?;
    let slug = branch_storage_slug(name)?;

    if dry_run {
        let probe = cow_clone_dir(Path::new(&src_branch.work), &work, true)?;
        return Ok(CreateBranchResult {
            dsn: dsn_for(&work.to_string_lossy()),
            method: Some(probe.method),
            elapsed_ms: Some(probe.elapsed_ms),
        });
    }

    let cloned = cow_clone_dir(Path::new(&src_branch.work), &work, false)?;
    fs::create_dir_all(&snapshot).map_err(|e| e.to_string())?;
    copy_dir_recursive(&work, &snapshot)?;

    let mut meta = meta;
    meta.branches.insert(
        name.into(),
        BranchEntry {
            work: work.to_string_lossy().into_owned(),
            snapshot: snapshot.to_string_lossy().into_owned(),
            slug,
        },
    );
    write_meta(root, &meta)?;
    Ok(CreateBranchResult {
        dsn: dsn_for(&work.to_string_lossy()),
        method: Some(cloned.method),
        elapsed_ms: Some(cloned.elapsed_ms),
    })
}

pub enum LinkKind {
    Junction,
    Symlink,
    Noop,
}

pub struct SwitchResult {
    pub dsn: String,
    pub link: Option<LinkKind>,
}

pub fn switch_branch(root: &Path, name: &str, dry_run: bool) -> Result<SwitchResult, String> {
    let meta = read_meta(root).ok_or("Store not initialized")?;
    if !meta.branches.contains_key(name) {
        return Err(format!("Branch missing: {name}"));
    }

    if dry_run {
        return Ok(SwitchResult {
            dsn: dsn_for(&meta.data_dir),
            link: Some(LinkKind::Noop),
        });
    }

    let mut meta = meta;
    persist_data_dir_to_branch(&meta, &meta.active);
    meta.active = name.into();
    write_meta(root, &meta)?;
    sync_active_data_dir(&meta)?;
    let link = if cfg!(windows) {
        LinkKind::Junction
    } else {
        LinkKind::Symlink
    };
    Ok(SwitchResult {
        dsn: dsn_for(&meta.data_dir),
        link: Some(link),
    })
}

pub struct ResetResult {
    pub restored: String,
    pub elapsed_ms: f64,
}

pub fn reset_branch(
    root: &Path,
    name: Option<&str>,
    dry_run: bool,
    allow_write: bool,
) -> Result<ResetResult, String> {
    if !allow_write && !dry_run {
        return Err("Read-only: pass --allow-write to reset branches.".into());
    }
    let start = std::time::Instant::now();
    let meta = read_meta(root).ok_or("Store not initialized")?;
    let target = name.unwrap_or(&meta.active);
    let branch = meta
        .branches
        .get(target)
        .ok_or_else(|| format!("Branch missing: {target}"))?;

    if dry_run {
        return Ok(ResetResult {
            restored: branch.snapshot.clone(),
            elapsed_ms: start.elapsed().as_secs_f64() * 1000.0,
        });
    }

    let data_dir = PathBuf::from(&meta.data_dir);
    let work = PathBuf::from(&branch.work);
    if data_dir.exists()
        && (meta.active == target || same_resolved_path(&data_dir, &work))
        && is_reparse_point(&data_dir)
    {
        remove_link_path(&data_dir)?;
    }

    fs::remove_dir_all(&work).map_err(|e| e.to_string())?;
    copy_dir_recursive(Path::new(&branch.snapshot), &work)?;
    if meta.active == target {
        sync_active_data_dir(&meta)?;
    }
    Ok(ResetResult {
        restored: branch.work.clone(),
        elapsed_ms: start.elapsed().as_secs_f64() * 1000.0,
    })
}

pub fn assert_embed_dim(meta: &BranchMeta, dim: u32) -> Result<(), String> {
    if let Some(lock) = meta.embed_dim {
        if lock != dim {
            return Err(format!(
                "Embedding dimension fingerprint mismatch: lock expects {lock}, got {dim}"
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
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

    fn seed_data(dir: &Path, content: &str) {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join("data.txt"), content).unwrap();
    }

    #[test]
    fn branch_isolation_and_reset() {
        let root_path = temp_test_dir("pgcow-branch");
        let data_dir = root_path.join("pgdata");
        seed_data(&data_dir, "main\n");
        ensure_store(&root_path, &data_dir).unwrap();

        create_branch(&root_path, "feat-a", Some("main"), false, true).unwrap();
        let meta = read_meta(&root_path).unwrap();
        let work = meta.branches["feat-a"].work.clone();
        fs::write(Path::new(&work).join("data.txt"), "feat\n").unwrap();

        switch_branch(&root_path, "main", false).unwrap();
        assert_eq!(
            fs::read_to_string(data_dir.join("data.txt")).unwrap(),
            "main\n"
        );

        switch_branch(&root_path, "feat-a", false).unwrap();
        assert_eq!(
            fs::read_to_string(data_dir.join("data.txt")).unwrap(),
            "feat\n"
        );

        let reset = reset_branch(&root_path, Some("feat-a"), false, true).unwrap();
        assert!(reset.elapsed_ms < 5000.0);
        assert_eq!(
            fs::read_to_string(data_dir.join("data.txt")).unwrap(),
            "main\n"
        );
        let _ = fs::remove_dir_all(&root_path);
    }

    #[test]
    fn embed_dim_guard() {
        let meta = BranchMeta {
            data_dir: "x".into(),
            active: "main".into(),
            branches: Default::default(),
            embed_dir: None,
            embed_dim: Some(1024),
        };
        assert!(assert_embed_dim(&meta, 768).is_err());
    }
}
