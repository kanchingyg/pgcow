use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use pgcow::branch_store::{
    create_branch, ensure_store, read_meta, reset_branch, switch_branch,
};
use pgcow::git_hook::sync_db_branch_from_git;
use pgcow::mcp::{run_mcp_server, set_guards};
use pgcow::VERSION;

struct ParsedArgs {
    flags: Vec<String>,
    rest: Vec<String>,
    data_dir: Option<String>,
}

fn parse_flags(argv: &[String]) -> ParsedArgs {
    let mut flags = Vec::new();
    let mut rest = Vec::new();
    let mut data_dir = None;
    let mut i = 0;
    while i < argv.len() {
        let a = &argv[i];
        if a == "--data-dir" && i + 1 < argv.len() {
            i += 1;
            data_dir = Some(argv[i].clone());
            i += 1;
            continue;
        }
        if a.starts_with("--") {
            flags.push(a.clone());
        } else {
            rest.push(a.clone());
        }
        i += 1;
    }
    ParsedArgs {
        flags,
        rest,
        data_dir,
    }
}

fn resolve_data_dir(explicit: Option<&str>) -> PathBuf {
    if let Some(d) = explicit {
        return PathBuf::from(d);
    }
    if let Ok(v) = env::var("PGCOW_DATA_DIR") {
        return PathBuf::from(v);
    }
    env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("pgdata")
}

fn main() {
    let argv: Vec<String> = env::args().skip(1).collect();
    let parsed = parse_flags(&argv);
    let root = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let data_dir = resolve_data_dir(parsed.data_dir.as_deref());

    let dry_run = parsed.flags.iter().any(|f| f == "--dry-run");
    let allow_write = parsed.flags.iter().any(|f| f == "--allow-write");
    set_guards(allow_write, dry_run);

    if parsed.flags.iter().any(|f| f == "--mcp") {
        if read_meta(&root).is_none() {
            if let Err(e) = ensure_store(&root, &data_dir) {
                eprintln!("{e}");
                std::process::exit(1);
            }
        }
        if let Err(e) = run_mcp_server(&root, &data_dir.to_string_lossy(), VERSION) {
            eprintln!("{e}");
            std::process::exit(1);
        }
        return;
    }

    let code = run_cli(&root, &data_dir, &parsed, allow_write, dry_run);
    std::process::exit(code);
}

fn run_cli(
    root: &Path,
    data_dir: &Path,
    parsed: &ParsedArgs,
    allow_write: bool,
    dry_run: bool,
) -> i32 {
    let cmd = parsed.rest.first().map(|s| s.as_str());

    if cmd.is_none() {
        eprint!(
            "Usage: pgcow branch <name> | checkout <name> | reset | sync-git [--allow-write] [--dry-run] [--mcp]\n"
        );
        return 2;
    }

    let cmd = cmd.unwrap();
    if !matches!(cmd, "init" | "branch" | "checkout" | "reset" | "sync-git") {
        eprintln!("Unknown command: {cmd}");
        return 2;
    }

    let result: Result<(), String> = (|| {
        match cmd {
            "init" => {
                fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
                let main_db = data_dir.join("main.db");
                if !main_db.exists() {
                    fs::write(data_dir.join("seed.txt"), "main\n").map_err(|e| e.to_string())?;
                }
                ensure_store(root, data_dir)?;
                Ok(())
            }
            "branch" => {
                if read_meta(root).is_none() {
                    ensure_store(root, data_dir)?;
                }
                let name = parsed
                    .rest
                    .get(1)
                    .ok_or("missing branch name".to_string())?;
                let res = create_branch(root, name, None, dry_run, allow_write)?;
                println!("{}", res.dsn);
                Ok(())
            }
            "checkout" => {
                if read_meta(root).is_none() {
                    ensure_store(root, data_dir)?;
                }
                let name = parsed
                    .rest
                    .get(1)
                    .ok_or("missing branch name".to_string())?;
                let res = switch_branch(root, name, dry_run)?;
                println!("{}", res.dsn);
                Ok(())
            }
            "reset" => {
                if read_meta(root).is_none() {
                    ensure_store(root, data_dir)?;
                }
                let name = parsed.rest.get(1).map(|s| s.as_str());
                let res = reset_branch(root, name, dry_run, allow_write)?;
                println!(
                    "restored {} in {:.1}ms",
                    res.restored,
                    res.elapsed_ms
                );
                Ok(())
            }
            "sync-git" => {
                if read_meta(root).is_none() {
                    ensure_store(root, data_dir)?;
                }
                let res = sync_db_branch_from_git(root, allow_write, None, dry_run, None)?;
                let suffix = if res.created { " (created)" } else { "" };
                println!("{}{}", res.branch, suffix);
                Ok(())
            }
            _ => Ok(()),
        }
    })();

    match result {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}
