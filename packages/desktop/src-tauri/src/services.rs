use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use tokio::process::Command;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ServiceInfo {
    pub label: String,
    pub pid: Option<i32>,
    pub last_exit_status: Option<i32>,
    pub status: String, // "running" | "stopped" | "error" | "unknown"
    pub category: String,
    pub plist_path: Option<String>,
    pub program: Option<String>,
    pub program_arguments: Option<Vec<String>>,
    pub run_at_load: Option<bool>,
    pub enabled: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ServiceDetail {
    pub path: Option<String>,
    pub r#type: Option<String>,
    pub bundle_id: Option<String>,
    pub state: Option<String>,
    pub environment: HashMap<String, String>,
    pub last_exit_reason: Option<String>,
}

struct LoadedService {
    pid: Option<i32>,
    exit_status: Option<i32>,
}

async fn exec_cmd(args: &[&str]) -> String {
    let output = Command::new(args[0])
        .args(&args[1..])
        .output()
        .await;
    match output {
        Ok(o) => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        Err(_) => String::new(),
    }
}

async fn get_loaded_services() -> HashMap<String, LoadedService> {
    let output = exec_cmd(&["launchctl", "list"]).await;
    let mut map = HashMap::new();
    for line in output.lines().skip(1) {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 3 {
            let pid = if parts[0] == "-" { None } else { parts[0].parse().ok() };
            let exit_status = if parts[1] == "-" { None } else { parts[1].parse().ok() };
            let label = parts[2..].join(" ");
            map.insert(label, LoadedService { pid, exit_status });
        }
    }
    map
}

#[allow(dead_code)]
fn categorize_path(path: &str) -> &'static str {
    if path.contains("/Library/LaunchAgents") {
        if path.starts_with("/System") { "system-agents" }
        else if path.starts_with("/Library") { "global-agents" }
        else { "user-agents" }
    } else if path.contains("/Library/LaunchDaemons") {
        if path.starts_with("/System") { "system-daemons" }
        else { "global-daemons" }
    } else {
        "user-agents"
    }
}

fn read_plist_info(path: &str) -> (Option<String>, Option<Vec<String>>, Option<bool>) {
    let val = match plist::Value::from_file(path) {
        Ok(v) => v,
        Err(_) => return (None, None, None),
    };
    let dict = match val.as_dictionary() {
        Some(d) => d,
        None => return (None, None, None),
    };

    let program = dict.get("Program").and_then(|v| v.as_string()).map(|s| s.to_string());
    let run_at_load = dict.get("RunAtLoad").and_then(|v| v.as_boolean());

    let args: Option<Vec<String>> = dict.get("ProgramArguments").and_then(|v| {
        v.as_array().map(|arr| {
            arr.iter().filter_map(|v| v.as_string().map(|s| s.to_string())).collect()
        })
    });

    let prog = program.clone().or_else(|| args.as_ref().and_then(|a| a.first().cloned()));
    (prog, args, run_at_load)
}

async fn discover_plists() -> Vec<(String, String, String)> {
    // (label, path, category)
    let home = dirs::home_dir().unwrap_or_default();
    let dirs_to_scan: Vec<(PathBuf, &str)> = vec![
        (home.join("Library/LaunchAgents"), "user-agents"),
        (PathBuf::from("/Library/LaunchAgents"), "global-agents"),
        (PathBuf::from("/Library/LaunchDaemons"), "global-daemons"),
        (PathBuf::from("/System/Library/LaunchAgents"), "system-agents"),
        (PathBuf::from("/System/Library/LaunchDaemons"), "system-daemons"),
    ];

    let mut results = Vec::new();
    for (dir, category) in dirs_to_scan {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.ends_with(".plist") || name.ends_with(".plist.disabled") {
                    let label = name.trim_end_matches(".disabled").trim_end_matches(".plist").to_string();
                    let path = entry.path().to_string_lossy().to_string();
                    results.push((label, path, category.to_string()));
                }
            }
        }
    }
    results
}

pub async fn list_services() -> Vec<ServiceInfo> {
    let (loaded, plists) = tokio::join!(get_loaded_services(), discover_plists());

    let mut services = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for (label, path, category) in &plists {
        seen.insert(label.clone());
        let loaded_info = loaded.get(label);
        let is_disabled = path.ends_with(".disabled");
        let (program, args, run_at_load) = read_plist_info(path);

        let status = match loaded_info {
            Some(l) if l.pid.map(|p| p > 0).unwrap_or(false) => "running",
            Some(l) if l.exit_status.map(|e| e != 0).unwrap_or(false) => "error",
            Some(_) => "stopped",
            None => "stopped",
        };

        services.push(ServiceInfo {
            label: label.clone(),
            pid: loaded_info.and_then(|l| l.pid),
            last_exit_status: loaded_info.and_then(|l| l.exit_status),
            status: status.into(),
            category: category.clone(),
            plist_path: Some(path.clone()),
            program,
            program_arguments: args,
            run_at_load,
            enabled: !is_disabled && loaded_info.is_some(),
        });
    }

    // Loaded services without plists
    for (label, info) in &loaded {
        if seen.contains(label) { continue; }
        let status = if info.pid.map(|p| p > 0).unwrap_or(false) { "running" }
            else if info.exit_status.map(|e| e != 0).unwrap_or(false) { "error" }
            else { "stopped" };

        services.push(ServiceInfo {
            label: label.clone(),
            pid: info.pid,
            last_exit_status: info.exit_status,
            status: status.into(),
            category: if label.starts_with("com.apple.") { "system-agents" } else { "user-agents" }.into(),
            plist_path: None,
            program: None,
            program_arguments: None,
            run_at_load: None,
            enabled: true,
        });
    }

    services.sort_by(|a, b| a.label.cmp(&b.label));
    services
}

pub async fn get_service_detail(label: &str) -> Option<ServiceDetail> {
    let uid = unsafe { libc::getuid() };
    let mut output = exec_cmd(&["launchctl", "print", &format!("gui/{}/{}", uid, label)]).await;
    if output.is_empty() {
        output = exec_cmd(&["launchctl", "print", &format!("system/{}", label)]).await;
    }
    if output.is_empty() { return None; }

    let mut detail = ServiceDetail {
        path: None, r#type: None, bundle_id: None, state: None,
        environment: HashMap::new(), last_exit_reason: None,
    };

    for line in output.lines() {
        let t = line.trim();
        if let Some(v) = t.strip_prefix("path = ") { detail.path = Some(v.into()); }
        else if let Some(v) = t.strip_prefix("type = ") { detail.r#type = Some(v.into()); }
        else if let Some(v) = t.strip_prefix("bundle id = ") { detail.bundle_id = Some(v.into()); }
        else if let Some(v) = t.strip_prefix("state = ") { detail.state = Some(v.into()); }
        else if let Some(v) = t.strip_prefix("last exit reason = ") { detail.last_exit_reason = Some(v.into()); }
    }

    Some(detail)
}

pub async fn start_service(label: &str) -> Result<(), String> {
    let uid = unsafe { libc::getuid() };
    let result = exec_cmd(&["launchctl", "kickstart", &format!("gui/{}/{}", uid, label)]).await;
    if result.contains("Could not find service") {
        let sys_result = exec_cmd(&["launchctl", "kickstart", &format!("system/{}", label)]).await;
        if sys_result.contains("Could not find service") {
            return Err("Service not found".into());
        }
    }
    Ok(())
}

pub async fn stop_service(label: &str) -> Result<(), String> {
    let uid = unsafe { libc::getuid() };
    exec_cmd(&["launchctl", "kill", "SIGTERM", &format!("gui/{}/{}", uid, label)]).await;
    Ok(())
}

pub async fn enable_service(plist_path: &str) -> Result<(), String> {
    let actual = plist_path.trim_end_matches(".disabled");
    if plist_path.ends_with(".disabled") {
        std::fs::rename(plist_path, actual).map_err(|e| e.to_string())?;
    }
    exec_cmd(&["launchctl", "load", "-w", actual]).await;
    Ok(())
}

pub async fn disable_service(label: &str, plist_path: Option<&str>) -> Result<(), String> {
    if let Some(path) = plist_path {
        exec_cmd(&["launchctl", "unload", "-w", path]).await;
    } else {
        exec_cmd(&["launchctl", "remove", label]).await;
    }
    Ok(())
}
