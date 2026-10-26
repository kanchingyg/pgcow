use std::io::{self, BufRead, Write};
use std::sync::Mutex;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::branch_store::{
    create_branch, ensure_store, read_meta, reset_branch, switch_branch,
};

const DEFAULT_N_CTX: usize = 4096;

static ALLOW_WRITE: Mutex<bool> = Mutex::new(false);
static DRY_RUN: Mutex<bool> = Mutex::new(false);
static N_CTX: Mutex<usize> = Mutex::new(DEFAULT_N_CTX);

static LOOP_LAST_HASH: Mutex<String> = Mutex::new(String::new());
static LOOP_REPEAT: Mutex<u32> = Mutex::new(0);

pub fn set_guards(allow_write: bool, dry_run: bool) {
    *ALLOW_WRITE.lock().unwrap() = allow_write;
    *DRY_RUN.lock().unwrap() = dry_run;
}

fn canonicalize_json(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into()),
        Value::Array(arr) => {
            let parts = arr.iter().map(canonicalize_json).collect::<Vec<_>>();
            format!("[{}]", parts.join(","))
        }
        Value::Object(map) => {
            let mut keys: Vec<_> = map.keys().collect();
            keys.sort();
            let parts = keys
                .iter()
                .map(|k| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(k).unwrap(),
                        canonicalize_json(&map[*k])
                    )
                })
                .collect::<Vec<_>>();
            format!("{{{}}}", parts.join(","))
        }
    }
}

pub fn reset_loop_breaker() {
    *LOOP_LAST_HASH.lock().unwrap() = String::new();
    *LOOP_REPEAT.lock().unwrap() = 0;
}

pub fn check_loop_breaker(tool_name: &str, args: &Value) -> Option<String> {
    let payload = format!("{}:{}", tool_name, canonicalize_json(args));
    let hash = hex::encode(Sha256::digest(payload.as_bytes()));
    let mut last = LOOP_LAST_HASH.lock().unwrap();
    let mut count = LOOP_REPEAT.lock().unwrap();
    if *last == hash {
        *count += 1;
    } else {
        *last = hash;
        *count = 1;
    }
    if *count >= 3 {
        return Some(
            "LOOP_BREAKER: Identical tool call repeated 2 times consecutively. Stop calling tools and return your final synthesis."
                .into(),
        );
    }
    None
}

fn guard_mutating(mutates: bool) -> Option<String> {
    if !mutates {
        return None;
    }
    if *DRY_RUN.lock().unwrap() {
        return None;
    }
    if !*ALLOW_WRITE.lock().unwrap() {
        return Some("Read-only mode: pass --allow-write to enable mutating tools.".into());
    }
    None
}

fn redact_secrets(text: &str) -> String {
    let mut out = text.to_string();
    if let Some(idx) = out.find("sk-") {
        let tail = &out[idx..];
        let len = tail
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '-')
            .count();
        if len >= 23 {
            out.replace_range(idx..idx + len, "[REDACTED]");
        }
    }
    if out.contains("Bearer ") {
        out = out.replace("Bearer ", "Bearer [REDACTED]");
    }
    out
}

fn head_tail_truncate(text: &str, max_chars: usize) -> String {
    if text.len() <= max_chars {
        return text.to_string();
    }
    let head = (max_chars as f64 * 0.6).floor() as usize;
    let tail = max_chars - head - 24;
    format!(
        "{}[...TRUNCATED...]{}",
        &text[..head],
        &text[text.len() - tail..]
    )
}

fn finalize_tool_text(text: &str) -> String {
    let n_ctx = *N_CTX.lock().unwrap();
    let budget = ((n_ctx * 4) as f64 * 0.3).floor() as usize;
    redact_secrets(&head_tail_truncate(text, budget))
}

fn write_json_rpc_frame(stdout: &mut io::StdoutLock, obj: &Value) {
    let line = format!("{}\n", obj);
    let _ = stdout.write_all(line.as_bytes());
    let _ = stdout.flush();
}

fn handle_tools_call(
    root: &std::path::Path,
    data_dir: &str,
    id: &Value,
    params: &Value,
    stdout: &mut io::StdoutLock,
) {
    let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));

    if let Some(err) = check_loop_breaker(name, &args) {
        write_json_rpc_frame(
            stdout,
            &json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "content": [{ "type": "text", "text": err }],
                    "isError": true
                }
            }),
        );
        return;
    }

    let mutates = matches!(name, "create_db_branch" | "reset_db_branch");
    if let Some(reason) = guard_mutating(mutates) {
        write_json_rpc_frame(
            stdout,
            &json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "content": [{ "type": "text", "text": reason }],
                    "isError": true
                }
            }),
        );
        return;
    }

    let dry = *DRY_RUN.lock().unwrap();
    let allow = *ALLOW_WRITE.lock().unwrap();

    let result: Result<Value, String> = (|| {
        match name {
            "create_db_branch" => {
                let branch_name = args
                    .get("name")
                    .and_then(|v| v.as_str())
                    .ok_or("missing name")?;
                let from = args.get("from").and_then(|v| v.as_str());
                if read_meta(root).is_none() {
                    ensure_store(root, std::path::Path::new(data_dir))?;
                }
                let res = create_branch(root, branch_name, from, dry, allow)?;
                Ok(json!({
                    "dsn": res.dsn,
                    "method": res.method.map(|m| m.as_str()),
                    "elapsedMs": res.elapsed_ms
                }))
            }
            "reset_db_branch" => {
                let branch_name = args.get("name").and_then(|v| v.as_str());
                let res = reset_branch(root, branch_name, dry, allow)?;
                Ok(json!({
                    "restored": res.restored,
                    "elapsedMs": res.elapsed_ms
                }))
            }
            "switch_db_branch" => {
                let branch_name = args
                    .get("name")
                    .and_then(|v| v.as_str())
                    .ok_or("missing name")?;
                let res = switch_branch(root, branch_name, false)?;
                Ok(json!({ "dsn": res.dsn }))
            }
            _ => Ok(json!({ "ok": false, "error": format!("Unknown tool: {name}") })),
        }
    })();

    match result {
        Ok(value) => {
            let text = serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string());
            write_json_rpc_frame(
                stdout,
                &json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "content": [{ "type": "text", "text": finalize_tool_text(&text) }]
                    }
                }),
            );
        }
        Err(e) => {
            write_json_rpc_frame(
                stdout,
                &json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "content": [{ "type": "text", "text": finalize_tool_text(&e) }],
                        "isError": true
                    }
                }),
            );
        }
    }
}

fn tool_list() -> Vec<Value> {
    vec![
        json!({
            "name": "create_db_branch",
            "description": "Clone data dir via CoW; returns DSN.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": { "type": "string" },
                    "from": { "type": "string" }
                },
                "required": ["name"],
                "additionalProperties": false
            },
            "annotations": { "destructiveHint": false, "readOnlyHint": false }
        }),
        json!({
            "name": "reset_db_branch",
            "description": "Restore branch snapshot instantly.",
            "inputSchema": {
                "type": "object",
                "properties": { "name": { "type": "string" } },
                "additionalProperties": false
            },
            "annotations": { "destructiveHint": true, "readOnlyHint": false }
        }),
        json!({
            "name": "switch_db_branch",
            "description": "Activate a DB branch and return DSN.",
            "inputSchema": {
                "type": "object",
                "properties": { "name": { "type": "string" } },
                "required": ["name"],
                "additionalProperties": false
            },
            "annotations": { "readOnlyHint": true }
        }),
    ]
}

pub fn dispatch_mcp_message(
    msg: &Value,
    root: &std::path::Path,
    data_dir: &str,
    version: &str,
    stdout: &mut io::StdoutLock,
) {
    let id = msg.get("id").cloned().unwrap_or(Value::Null);
    let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));

    if method == "initialize" {
        write_json_rpc_frame(
            stdout,
            &json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "pgcow", "version": version }
                }
            }),
        );
        return;
    }
    if method == "notifications/initialized" {
        return;
    }
    if method == "tools/list" {
        write_json_rpc_frame(
            stdout,
            &json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": { "tools": tool_list() }
            }),
        );
        return;
    }
    if method == "tools/call" {
        handle_tools_call(root, data_dir, &id, &params, stdout);
        return;
    }
    if !id.is_null() {
        write_json_rpc_frame(
            stdout,
            &json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32601, "message": format!("Method not found: {method}") }
            }),
        );
    }
}

pub fn run_mcp_server(root: &std::path::Path, data_dir: &str, version: &str) -> io::Result<()> {
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    let mut reader = stdin.lock();
    let mut buffer = String::new();
    loop {
        buffer.clear();
        let read = reader.read_line(&mut buffer)?;
        if read == 0 {
            break;
        }
        let line = buffer.trim();
        if line.is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(line) {
            Ok(msg) => dispatch_mcp_message(&msg, root, data_dir, version, &mut stdout),
            Err(_) => continue,
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loop_breaker_trips_on_third_identical_call() {
        reset_loop_breaker();
        let args = json!({});
        assert!(check_loop_breaker("reset_db_branch", &args).is_none());
        assert!(check_loop_breaker("reset_db_branch", &args).is_none());
        assert!(check_loop_breaker("reset_db_branch", &args).is_some());
    }

    #[test]
    fn guard_blocks_mutating_without_allow_write() {
        set_guards(false, false);
        assert!(guard_mutating(true).is_some());
        set_guards(true, false);
        assert!(guard_mutating(true).is_none());
    }

    #[test]
    fn tools_list_has_three_entries() {
        assert_eq!(tool_list().len(), 3);
        assert_eq!(
            tool_list()[0].get("name").and_then(|v| v.as_str()),
            Some("create_db_branch")
        );
    }
}
