use std::fs;
use std::path::Path;
use std::process::Command;
use std::time::Instant;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CowMethod {
    Reflink,
    Clonefile,
    Hardlink,
    Copy,
}

impl CowMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            CowMethod::Reflink => "reflink",
            CowMethod::Clonefile => "clonefile",
            CowMethod::Hardlink => "hardlink",
            CowMethod::Copy => "copy",
        }
    }
}

pub struct CowCloneResult {
    pub method: CowMethod,
    pub elapsed_ms: f64,
}

fn path_exists(p: &Path) -> bool {
    p.exists()
}

pub fn probe_cow_support(sample_dir: &Path) -> (bool, CowMethod) {
    if !path_exists(sample_dir) {
        return (false, CowMethod::Copy);
    }
    if cfg!(target_os = "macos") {
        return (true, CowMethod::Clonefile);
    }
    if cfg!(target_os = "linux") {
        return (true, CowMethod::Reflink);
    }
    if cfg!(target_os = "windows") {
        return (true, CowMethod::Copy);
    }
    (true, CowMethod::Hardlink)
}

fn try_reflink_cp(src: &Path, dest: &Path) -> bool {
    if cfg!(target_os = "macos") {
        return Command::new("cp")
            .args(["-c", "-R"])
            .arg(src)
            .arg(dest)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
    }
    if cfg!(target_os = "linux") {
        return Command::new("cp")
            .args(["--reflink=auto", "-R"])
            .arg(src)
            .arg(dest)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
    }
    if cfg!(target_os = "windows") {
        let src_s = src.to_string_lossy().replace('\'', "''");
        let dest_s = dest.to_string_lossy().replace('\'', "''");
        let script = format!(
            "Copy-Item -LiteralPath '{}' -Destination '{}' -Recurse -Force",
            src_s,
            dest_s
        );
        return Command::new("powershell")
            .args(["-NoProfile", "-Command", &script])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
    }
    false
}

pub fn hardlink_tree(src: &Path, dest: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let s = entry.path();
        let d = dest.join(entry.file_name());
        let ft = entry.file_type()?;
        if ft.is_dir() {
            hardlink_tree(&s, &d)?;
        } else if ft.is_file() {
            if fs::hard_link(&s, &d).is_err() {
                fs::copy(&s, &d)?;
            }
        }
    }
    Ok(())
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let s = entry.path();
        let d = dest.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&s, &d)?;
        } else {
            fs::copy(&s, &d)?;
        }
    }
    Ok(())
}

pub fn cow_clone_dir(src: &Path, dest: &Path, dry_run: bool) -> Result<CowCloneResult, String> {
    let start = Instant::now();
    if dry_run {
        let (_, method) = probe_cow_support(src);
        return Ok(CowCloneResult {
            method,
            elapsed_ms: start.elapsed().as_secs_f64() * 1000.0,
        });
    }

    if path_exists(dest) {
        return Err(format!("Destination already exists: {}", dest.display()));
    }

    if cfg!(target_os = "windows") {
        copy_dir_recursive(src, dest).map_err(|e| e.to_string())?;
        return Ok(CowCloneResult {
            method: CowMethod::Copy,
            elapsed_ms: start.elapsed().as_secs_f64() * 1000.0,
        });
    }

    if try_reflink_cp(src, dest) {
        let method = if cfg!(target_os = "macos") {
            CowMethod::Clonefile
        } else {
            CowMethod::Reflink
        };
        return Ok(CowCloneResult {
            method,
            elapsed_ms: start.elapsed().as_secs_f64() * 1000.0,
        });
    }

    if hardlink_tree(src, dest).is_ok() {
        return Ok(CowCloneResult {
            method: CowMethod::Hardlink,
            elapsed_ms: start.elapsed().as_secs_f64() * 1000.0,
        });
    }

    copy_dir_recursive(src, dest).map_err(|e| e.to_string())?;
    Ok(CowCloneResult {
        method: CowMethod::Copy,
        elapsed_ms: start.elapsed().as_secs_f64() * 1000.0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_test_dir(prefix: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("{}-{}", prefix, nanos));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn cow_clone_small_tree() {
        let dir = temp_test_dir("pgcow-tiny");
        let src = dir.join("tiny");
        fs::create_dir_all(&src).unwrap();
        let mut f = fs::File::create(src.join("data.txt")).unwrap();
        f.write_all(b"x\n").unwrap();

        let dest = dir.join("tiny-clone");
        let res = cow_clone_dir(&src, &dest, false).unwrap();
        assert!(dest.join("data.txt").exists());
        assert!(res.elapsed_ms < 5000.0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn hardlink_tree_clones() {
        let dir = temp_test_dir("pgcow-hl");
        let src = dir.join("src");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("data.txt"), "hl\n").unwrap();
        let dest = dir.join("dest");
        hardlink_tree(&src, &dest).unwrap();
        assert_eq!(fs::read_to_string(dest.join("data.txt")).unwrap(), "hl\n");
        let _ = fs::remove_dir_all(&dir);
    }
}
