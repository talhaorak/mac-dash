// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod job_extras;
mod job_monitor;
mod launchd;
mod logs;
mod processes;
mod services;
mod system_info;
mod tray;

use serde::Serialize;
use std::collections::BTreeMap;
use tauri::Manager;

const MAIN_WINDOW: &str = "main";
const ABOUT_WINDOW: &str = "about";
/// Custom URI scheme that serves the embedded About page.
const ABOUT_SCHEME: &str = "macdash";
const ABOUT_HTML: &str = include_str!("../about.html");

/// The only URLs `open_external` hands to the system browser. They are the links of the About page.
const EXTERNAL_URLS: [&str; 3] = [
    "https://github.com/talhaorak/mac-dash",
    "https://talhaorak.github.io/mac-dash",
    "https://opensource.org/licenses/MIT",
];

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

fn api<T: Serialize>(result: Result<T, String>) -> ApiResult<T> {
    match result {
        Ok(data) => ok_result(data),
        Err(e) => err_result(e),
    }
}

/// Commands that change the system or read user data only answer the dashboard window.
/// Other windows (About) have no business calling them.
fn require_main(window: &tauri::Window) -> Result<(), String> {
    if window.label() == MAIN_WINDOW {
        Ok(())
    } else {
        Err("This command is only available to the main window.".to_string())
    }
}

macro_rules! main_window_only {
    ($window:expr) => {
        if let Err(e) = require_main(&$window) {
            return err_result(e);
        }
    };
}

/// Run blocking work (sysinfo, file system) off the main thread and off the async workers.
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tokio::task::spawn_blocking(work).await.map_err(|e| e.to_string())
}

// ── System Info Commands ─────────────────────────────────────────────

#[tauri::command]
async fn get_system_info() -> ApiResult<system_info::SystemStats> {
    api(blocking(system_info::get_system_stats).await)
}

#[tauri::command]
async fn get_hardware_info() -> ApiResult<system_info::HardwareInfo> {
    api(blocking(system_info::get_hardware_info).await)
}

// ── launchd Job Commands (docs/backend-contract.md) ──────────────────

#[tauri::command]
async fn get_services(window: tauri::Window) -> ApiResult<Vec<services::ServiceInfo>> {
    main_window_only!(window);
    ok_result(services::list_services().await)
}

#[tauri::command]
async fn get_service_detail(
    window: tauri::Window,
    label: String,
    category: String,
) -> ApiResult<Option<services::ServiceDetail>> {
    main_window_only!(window);
    api(services::get_service_detail(&label, &category).await)
}

#[tauri::command]
async fn manage_service(window: tauri::Window, label: String, category: String, action: String) -> ApiResult<()> {
    main_window_only!(window);
    api(services::manage_service(&label, &category, &action).await)
}

#[tauri::command]
async fn read_job(window: tauri::Window, label: String, category: String) -> ApiResult<Option<services::JobDocument>> {
    main_window_only!(window);
    api(services::read_job(&label, &category).await)
}

#[tauri::command]
async fn save_job(window: tauri::Window, request: services::SaveJobRequest) -> ApiResult<services::SavedJob> {
    main_window_only!(window);
    api(services::save_job(request).await)
}

#[tauri::command]
async fn delete_job(window: tauri::Window, label: String, category: String) -> ApiResult<()> {
    main_window_only!(window);
    let result = services::delete_job(&label, &category).await;
    if result.is_ok() {
        // No orphaned notes and tags, like DELETE /api/services/job
        let _ = job_extras::set_job_meta(&label, &category, "", &[]).await;
    }
    api(result)
}

#[tauri::command]
async fn read_job_output(
    window: tauri::Window,
    label: String,
    category: String,
    stream: String,
    lines: Option<i64>,
) -> ApiResult<services::JobOutput> {
    main_window_only!(window);
    api(services::read_job_output(&label, &category, &stream, lines).await)
}

#[tauri::command]
async fn check_paths(window: tauri::Window, paths: Vec<String>) -> ApiResult<Vec<services::PathFacts>> {
    main_window_only!(window);
    ok_result(services::check_paths(paths).await)
}

#[tauri::command]
async fn reveal_job(window: tauri::Window, label: String, category: String) -> ApiResult<()> {
    main_window_only!(window);
    api(services::reveal_job(&label, &category).await)
}

#[tauri::command]
async fn get_job_events(window: tauri::Window) -> ApiResult<Vec<job_monitor::JobEvent>> {
    main_window_only!(window);
    ok_result(job_monitor::get_job_events().await)
}

#[tauri::command]
async fn clear_job_events(window: tauri::Window) -> ApiResult<()> {
    main_window_only!(window);
    api(job_monitor::clear_job_events().await)
}

#[tauri::command]
async fn get_job_meta(window: tauri::Window) -> ApiResult<BTreeMap<String, job_extras::JobMeta>> {
    main_window_only!(window);
    ok_result(job_extras::get_job_meta().await)
}

#[tauri::command]
async fn set_job_meta(
    window: tauri::Window,
    label: String,
    category: String,
    notes: Option<String>,
    tags: Option<Vec<String>>,
) -> ApiResult<()> {
    main_window_only!(window);
    api(job_extras::set_job_meta(&label, &category, &notes.unwrap_or_default(), &tags.unwrap_or_default()).await)
}

#[tauri::command]
async fn list_job_revisions(window: tauri::Window, label: String) -> ApiResult<Vec<job_extras::JobRevision>> {
    main_window_only!(window);
    ok_result(job_extras::list_job_revisions(label).await)
}

#[tauri::command]
async fn read_job_revision(window: tauri::Window, id: String) -> ApiResult<String> {
    main_window_only!(window);
    api(job_extras::read_job_revision(id).await)
}

#[tauri::command]
async fn get_startup_extras(window: tauri::Window) -> ApiResult<job_extras::StartupExtras> {
    main_window_only!(window);
    ok_result(job_extras::get_startup_extras().await)
}

#[tauri::command]
async fn get_login_items(window: tauri::Window) -> ApiResult<Vec<job_extras::LoginItem>> {
    main_window_only!(window);
    api(job_extras::get_login_items().await)
}

#[tauri::command]
async fn list_shortcuts(window: tauri::Window) -> ApiResult<Vec<String>> {
    main_window_only!(window);
    ok_result(job_extras::list_shortcuts().await)
}

// ── Process Commands ─────────────────────────────────────────────────

#[tauri::command]
async fn get_processes(
    window: tauri::Window,
    sort: Option<String>,
    limit: Option<i64>,
    search: Option<String>,
) -> ApiResult<processes::ProcessList> {
    main_window_only!(window);
    api(blocking(move || processes::list_processes(sort.as_deref(), limit, search.as_deref())).await)
}

#[tauri::command]
async fn get_process_detail(window: tauri::Window, pid: u32) -> ApiResult<processes::ProcessDetail> {
    main_window_only!(window);
    match blocking(move || processes::get_process_detail(pid)).await {
        Ok(Some(detail)) => ok_result(detail),
        Ok(None) => err_result("Process not found".to_string()),
        Err(e) => err_result(e),
    }
}

#[tauri::command]
async fn kill_process(window: tauri::Window, pid: u32, force: Option<bool>) -> ApiResult<()> {
    main_window_only!(window);
    api(processes::kill_process(pid, force.unwrap_or(false)))
}

// ── Log Commands ─────────────────────────────────────────────────────

#[tauri::command]
fn start_log_stream(window: tauri::Window) -> ApiResult<()> {
    main_window_only!(window);
    logs::start_log_stream();
    ok_result(())
}

#[tauri::command]
fn stop_log_stream(window: tauri::Window) -> ApiResult<()> {
    main_window_only!(window);
    logs::stop_log_stream();
    ok_result(())
}

#[tauri::command]
fn get_recent_logs(window: tauri::Window, count: Option<usize>) -> ApiResult<Vec<logs::LogEntry>> {
    main_window_only!(window);
    ok_result(logs::get_recent_logs(count.unwrap_or(100)))
}

#[tauri::command]
async fn query_logs(
    window: tauri::Window,
    minutes: Option<u32>,
    predicate: Option<String>,
) -> ApiResult<Vec<logs::LogEntry>> {
    main_window_only!(window);
    ok_result(logs::query_logs(minutes.unwrap_or(5), predicate.as_deref()).await)
}

#[tauri::command]
fn get_active_log_processes(window: tauri::Window) -> ApiResult<Vec<serde_json::Value>> {
    main_window_only!(window);
    let procs = logs::get_active_log_processes();
    let result: Vec<serde_json::Value> = procs
        .into_iter()
        .map(|(name, count, last_seen)| serde_json::json!({ "name": name, "count": count, "lastSeen": last_seen }))
        .collect();
    ok_result(result)
}

// ── Window Commands ──────────────────────────────────────────────────

#[tauri::command]
fn begin_window_drag(window: tauri::Window) -> Result<(), String> {
    window
        .start_dragging()
        .map_err(|e| format!("start_dragging failed: {}", e))
}

/// Show and focus the dashboard. The window is hidden, not closed, when the user closes it.
pub(crate) fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    logs::resume_log_stream();
}

/// Open one of the known links in the default browser. Anything else is refused,
/// so a compromised page cannot use this command to open arbitrary URLs or files.
#[tauri::command]
async fn open_external(url: String) -> ApiResult<()> {
    if !EXTERNAL_URLS.contains(&url.as_str()) {
        return err_result("This link is not allowed.".to_string());
    }
    let status = tokio::process::Command::new("/usr/bin/open")
        .arg(&url)
        .stdin(std::process::Stdio::null())
        .status()
        .await;
    match status {
        Ok(s) if s.success() => ok_result(()),
        Ok(s) => err_result(format!("open exited with {}", s)),
        Err(e) => err_result(e.to_string()),
    }
}

// ── Menu & About Window ──────────────────────────────────────────────

fn random_nonce() -> String {
    let mut bytes = [0u8; 16];
    // SAFETY: the buffer is valid for `len` bytes. arc4random_buf cannot fail.
    unsafe { libc::arc4random_buf(bytes.as_mut_ptr().cast(), bytes.len()) };
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// The About page is embedded in the binary and served from `macdash://localhost/about.html`.
/// It is not part of the frontend bundle, so the asset protocol cannot serve it.
fn about_response(path: &str) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::{header, Response, StatusCode};

    if path != "/about.html" {
        return Response::builder().status(StatusCode::NOT_FOUND).body(Vec::new()).unwrap_or_default();
    }
    let nonce = random_nonce();
    let html = ABOUT_HTML.replace("{{NONCE}}", &nonce).replace("{{VERSION}}", env!("CARGO_PKG_VERSION"));
    let csp = format!(
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-{}'; connect-src ipc: http://ipc.localhost; base-uri 'none'; form-action 'none'",
        nonce
    );
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CONTENT_SECURITY_POLICY, csp)
        .header(header::CACHE_CONTROL, "no-store")
        .body(html.into_bytes())
        .unwrap_or_default()
}

#[tauri::command]
fn show_about_window(app: tauri::AppHandle) {
    // Check if about window already exists
    if let Some(window) = app.get_webview_window(ABOUT_WINDOW) {
        let _ = window.set_focus();
        return;
    }

    let Ok(url) = format!("{}://localhost/about.html", ABOUT_SCHEME).parse() else {
        return;
    };
    let _ = tauri::WebviewWindowBuilder::new(&app, ABOUT_WINDOW, tauri::WebviewUrl::CustomProtocol(url))
        .title("About Mac Dash")
        .inner_size(450.0, 580.0)
        .resizable(false)
        .center()
        .focused(true)
        // Links open in the browser through `open_external`. The page itself never navigates.
        .on_navigation(|url| url.scheme() == ABOUT_SCHEME)
        .build();
}

fn setup_menu(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::*;

    let about = MenuItemBuilder::with_id("about", "About Mac Dash").build(app)?;
    let app_menu = SubmenuBuilder::new(app, "Mac Dash")
        .item(&about)
        .separator()
        .hide()
        .hide_others()
        .separator()
        .quit()
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
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
        Ok(updater) => match updater.check().await {
            Ok(Some(update)) => Ok(Some(serde_json::json!({
                "version": update.version,
                "date": update.date,
                "body": update.body
            }))),
            Ok(None) => Ok(None),
            Err(e) => Err(format!("Update check failed: {}", e)),
        },
        Err(e) => Err(format!("Updater not available: {}", e)),
    }
}

#[tauri::command]
async fn install_update(app: tauri::AppHandle, window: tauri::Window) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;

    require_main(&window)?;
    match app.updater() {
        Ok(updater) => {
            match updater.check().await {
                Ok(Some(update)) => {
                    // Download and install
                    update
                        .download_and_install(|_, _| {}, || {})
                        .await
                        .map_err(|e| format!("Update installation failed: {}", e))?;

                    // Restart app
                    app.restart();
                }
                Ok(None) => Err("No update available".into()),
                Err(e) => Err(format!("Update check failed: {}", e)),
            }
        }
        Err(e) => Err(format!("Updater not available: {}", e)),
    }
}

// ── Main ─────────────────────────────────────────────────────────────

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .register_uri_scheme_protocol(ABOUT_SCHEME, |_ctx, request| about_response(request.uri().path()))
        .on_window_event(|window, event| {
            if window.label() != MAIN_WINDOW {
                return;
            }
            match event {
                // Close to tray: the monitor keeps running. Quit is in the tray menu and the app menu.
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = window.hide();
                    logs::pause_log_stream();
                }
                tauri::WindowEvent::Focused(true) => logs::resume_log_stream(),
                _ => {}
            }
        })
        .setup(|app| {
            setup_menu(app)?;
            tray::setup_tray(app)?;
            // Start log stream automatically
            logs::start_log_stream();
            // Watch the launchd scope directories for the lifetime of the app
            job_monitor::start(app.handle().clone());

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
            read_job,
            save_job,
            delete_job,
            read_job_output,
            check_paths,
            reveal_job,
            get_job_events,
            clear_job_events,
            get_job_meta,
            set_job_meta,
            list_job_revisions,
            read_job_revision,
            get_startup_extras,
            get_login_items,
            list_shortcuts,
            get_processes,
            get_process_detail,
            kill_process,
            start_log_stream,
            stop_log_stream,
            get_recent_logs,
            query_logs,
            get_active_log_processes,
            begin_window_drag,
            show_about_window,
            open_external,
            check_for_updates,
            install_update,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Mac Dash");

    app.run(|app_handle, event| match event {
        // The Dock icon was clicked while the window was hidden.
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { has_visible_windows: false, .. } => show_main_window(app_handle),
        // The `log stream` child must not outlive the app.
        tauri::RunEvent::Exit => logs::shutdown(),
        _ => {}
    });
}
