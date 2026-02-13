// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod system_info;
mod services;
mod processes;
mod logs;
mod tray;

use serde::Serialize;

#[derive(Serialize)]
struct ApiResult<T: Serialize> {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn ok_result<T: Serialize>(data: T) -> ApiResult<T> {
    ApiResult { ok: true, data: Some(data), error: None }
}

fn err_result<T: Serialize>(msg: String) -> ApiResult<T> {
    ApiResult { ok: false, data: None, error: Some(msg) }
}

// ── System Info Commands ─────────────────────────────────────────────

#[tauri::command]
fn get_system_info() -> ApiResult<system_info::SystemStats> {
    ok_result(system_info::get_system_stats())
}

#[tauri::command]
fn get_hardware_info() -> ApiResult<system_info::HardwareInfo> {
    ok_result(system_info::get_hardware_info())
}

// ── Services Commands ────────────────────────────────────────────────

#[tauri::command]
async fn get_services() -> ApiResult<Vec<services::ServiceInfo>> {
    ok_result(services::list_services().await)
}

#[tauri::command]
async fn get_service_detail(label: String) -> ApiResult<Option<services::ServiceDetail>> {
    ok_result(services::get_service_detail(&label).await)
}

#[tauri::command]
async fn manage_service(label: String, action: String, plist_path: Option<String>) -> ApiResult<()> {
    let result = match action.as_str() {
        "start" => services::start_service(&label).await,
        "stop" => services::stop_service(&label).await,
        "enable" => match plist_path {
            Some(path) => services::enable_service(&path).await,
            None => Err("plistPath required for enable".into()),
        },
        "disable" => services::disable_service(&label, plist_path.as_deref()).await,
        _ => Err(format!("Unknown action: {}", action)),
    };
    match result {
        Ok(()) => ok_result(()),
        Err(e) => err_result(e),
    }
}

// ── Process Commands ─────────────────────────────────────────────────

#[tauri::command]
fn get_processes() -> ApiResult<Vec<processes::ProcessInfo>> {
    ok_result(processes::list_processes())
}

#[tauri::command]
fn kill_process(pid: u32, force: bool) -> ApiResult<()> {
    match processes::kill_process(pid, force) {
        Ok(()) => ok_result(()),
        Err(e) => err_result(e),
    }
}

// ── Log Commands ─────────────────────────────────────────────────────

#[tauri::command]
fn start_log_stream() -> ApiResult<()> {
    logs::start_log_stream();
    ok_result(())
}

#[tauri::command]
fn stop_log_stream() -> ApiResult<()> {
    logs::stop_log_stream();
    ok_result(())
}

#[tauri::command]
fn get_recent_logs(count: Option<usize>) -> ApiResult<Vec<logs::LogEntry>> {
    ok_result(logs::get_recent_logs(count.unwrap_or(100)))
}

#[tauri::command]
async fn query_logs(minutes: Option<u32>, predicate: Option<String>) -> ApiResult<Vec<logs::LogEntry>> {
    ok_result(logs::query_logs(minutes.unwrap_or(5), predicate.as_deref()).await)
}

#[tauri::command]
fn get_active_log_processes() -> ApiResult<Vec<serde_json::Value>> {
    let procs = logs::get_active_log_processes();
    let result: Vec<serde_json::Value> = procs.into_iter().map(|(name, count, last_seen)| {
        serde_json::json!({ "name": name, "count": count, "lastSeen": last_seen })
    }).collect();
    ok_result(result)
}

// ── Window Commands ──────────────────────────────────────────────────

#[tauri::command]
fn begin_window_drag(window: tauri::Window) -> Result<(), String> {
    window
        .start_dragging()
        .map_err(|e| format!("start_dragging failed: {}", e))
}

// ── Menu & About Window ──────────────────────────────────────────────

#[tauri::command]
fn show_about_window(app: tauri::AppHandle) {
    use tauri::Manager;
    
    // Check if about window already exists
    if let Some(window) = app.get_webview_window("about") {
        let _ = window.set_focus();
        return;
    }
    
    // Create new about window
    let _ = tauri::WebviewWindowBuilder::new(
        &app,
        "about",
        tauri::WebviewUrl::App("about.html".into())
    )
    .title("About Mac Dash")
    .inner_size(450.0, 580.0)
    .resizable(false)
    .center()
    .focused(true)
    .build();
}

fn setup_menu(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::{menu::*, Manager};
    
    let app_menu = SubmenuBuilder::new(app, "Mac Dash")
        .about(Some(AboutMetadata::default()))
        .separator()
        .quit()
        .build()?;
    
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .copy()
        .paste()
        .select_all()
        .build()?;
    
    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .close_window()
        .build()?;
    
    let menu = MenuBuilder::new(app)
        .item(&app_menu)
        .item(&edit_menu)
        .item(&window_menu)
        .build()?;
    
    app.set_menu(menu)?;
    
    // Handle about menu click
    app.on_menu_event(move |app, event| {
        if event.id() == "about" {
            show_about_window(app.clone());
        }
    });
    
    Ok(())
}

// ── Updater ──────────────────────────────────────────────────────────

#[tauri::command]
async fn check_for_updates(app: tauri::AppHandle) -> Result<Option<serde_json::Value>, String> {
    use tauri_plugin_updater::UpdaterExt;
    
    match app.updater() {
        Ok(updater) => {
            match updater.check().await {
                Ok(Some(update)) => {
                    Ok(Some(serde_json::json!({
                        "version": update.version,
                        "date": update.date,
                        "body": update.body
                    })))
                }
                Ok(None) => Ok(None),
                Err(e) => Err(format!("Update check failed: {}", e))
            }
        }
        Err(e) => Err(format!("Updater not available: {}", e))
    }
}

#[tauri::command]
async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    
    match app.updater() {
        Ok(updater) => {
            match updater.check().await {
                Ok(Some(update)) => {
                    // Download and install
                    update.download_and_install(|_, _| {}, || {})
                        .await
                        .map_err(|e| format!("Update installation failed: {}", e))?;
                    
                    // Restart app
                    app.restart();
                }
                Ok(None) => Err("No update available".into()),
                Err(e) => Err(format!("Update check failed: {}", e))
            }
        }
        Err(e) => Err(format!("Updater not available: {}", e))
    }
}

// ── Main ─────────────────────────────────────────────────────────────

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            setup_menu(app)?;
            tray::setup_tray(app)?;
            // Start log stream automatically
            logs::start_log_stream();
            
            // Check for updates on startup (async, non-blocking)
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                use tauri_plugin_updater::UpdaterExt;
                if let Ok(updater) = app_handle.updater() {
                    let _ = updater.check().await;
                }
            });
            
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_system_info,
            get_hardware_info,
            get_services,
            get_service_detail,
            manage_service,
            get_processes,
            kill_process,
            start_log_stream,
            stop_log_stream,
            get_recent_logs,
            query_logs,
            get_active_log_processes,
            begin_window_drag,
            show_about_window,
            check_for_updates,
            install_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Mac Dash");
}
