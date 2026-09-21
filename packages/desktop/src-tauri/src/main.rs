// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod helper_tools;
mod job_extras;
mod job_monitor;
mod launchd;
mod logs;
mod processes;
mod services;
mod startup_tools;
mod system_info;
mod tray;
mod windows;

use serde::Serialize;
use std::collections::BTreeMap;
use tauri::Manager;

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

/// Commands that change the system or read user data only answer the dashboard windows
/// (`main`, `main-2`, …). Other windows (About) have no business calling them.
fn require_main(window: &tauri::Window) -> Result<(), String> {
    if windows::is_dashboard_label(window.label()) {
        Ok(())
    } else {
        Err("This command is only available to the dashboard windows.".to_string())
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
        let _ = job_extras::set_job_meta(&label, &category, "", &[], None).await;
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
    icon: Option<String>,
) -> ApiResult<()> {
    main_window_only!(window);
    api(job_extras::set_job_meta(&label, &category, &notes.unwrap_or_default(), &tags.unwrap_or_default(), icon.as_deref()).await)
}

#[tauri::command]
async fn delete_helper_tool(window: tauri::Window, name: String, permanent: Option<bool>) -> ApiResult<()> {
    main_window_only!(window);
    api(helper_tools::delete_helper_tool(&name, permanent.unwrap_or(false)).await)
}

#[tauri::command]
async fn reset_background_items(window: tauri::Window) -> ApiResult<()> {
    main_window_only!(window);
    api(helper_tools::reset_background_items().await)
}

#[tauri::command]
async fn browse_path(window: tauri::Window, path: Option<String>) -> ApiResult<helper_tools::BrowseResult> {
    main_window_only!(window);
    api(helper_tools::browse_path(path.unwrap_or_default()).await)
}

#[tauri::command]
async fn get_default_path(window: tauri::Window) -> ApiResult<String> {
    main_window_only!(window);
    ok_result(helper_tools::get_default_path().await)
}

#[tauri::command]
async fn get_job_plists(window: tauri::Window) -> ApiResult<BTreeMap<String, serde_json::Value>> {
    main_window_only!(window);
    ok_result(helper_tools::get_job_plists().await)
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

#[tauri::command]
async fn get_job_signature(window: tauri::Window, label: String, category: String) -> ApiResult<startup_tools::JobSignature> {
    main_window_only!(window);
    api(startup_tools::get_job_signature(&label, &category).await)
}

#[tauri::command]
async fn get_background_items(window: tauri::Window) -> ApiResult<std::sync::Arc<Vec<startup_tools::BackgroundItem>>> {
    main_window_only!(window);
    match startup_tools::get_background_items().await {
        Ok(items) => ok_result(items),
        // Contract: an empty list, and the stderr text as the error
        Err(e) => ApiResult { ok: false, data: Some(Default::default()), error: Some(e) },
    }
}

#[tauri::command]
async fn delete_login_item(window: tauri::Window, name: String) -> ApiResult<()> {
    main_window_only!(window);
    api(startup_tools::delete_login_item(&name).await)
}

#[tauri::command]
async fn build_script_app(window: tauri::Window, script_path: String, name: String) -> ApiResult<startup_tools::BuiltApp> {
    main_window_only!(window);
    api(startup_tools::build_script_app(&script_path, &name).await)
}

#[tauri::command]
async fn get_power_schedule(window: tauri::Window) -> ApiResult<startup_tools::PowerSchedule> {
    main_window_only!(window);
    api(startup_tools::get_power_schedule().await)
}

#[tauri::command]
async fn set_power_schedule(window: tauri::Window, events: Vec<startup_tools::PowerEvent>) -> ApiResult<()> {
    main_window_only!(window);
    api(startup_tools::set_power_schedule(&events).await)
}

#[tauri::command]
async fn get_monitor_settings(window: tauri::Window) -> ApiResult<job_monitor::MonitorSettings> {
    main_window_only!(window);
    ok_result(job_monitor::get_monitor_settings().await)
}

#[tauri::command]
async fn set_monitor_settings(window: tauri::Window, notify: bool, exclude: Option<Vec<String>>) -> ApiResult<()> {
    main_window_only!(window);
    api(job_monitor::set_monitor_settings(notify, exclude.unwrap_or_default()).await)
}

// ── Self-test (debug builds only) ────────────────────────────────────

/// Exit code and the one output line for a self-test report: 0 when the JSON has `"ok": true`,
/// 1 when it does not, 2 when the report is not JSON.
#[cfg(any(debug_assertions, test))]
fn selftest_outcome(report: &str) -> (i32, String) {
    match serde_json::from_str::<serde_json::Value>(report) {
        Ok(value) => {
            let code = if value.get("ok").and_then(|ok| ok.as_bool()) == Some(true) { 0 } else { 1 };
            // The report as it came, when it is one line. Pretty-printed JSON is printed compact.
            let one_line = if report.contains(['\n', '\r']) { value.to_string() } else { report.to_string() };
            (code, format!("SELFTEST_REPORT {}", one_line))
        }
        Err(_) => (2, format!("SELFTEST_REPORT {}", report.replace(['\n', '\r'], " "))),
    }
}

/// The web client runs its self-test (`?selftest=1`) and hands the result over. The process prints
/// one line and exits, so that a script can verify the desktop build without GUI automation.
/// This command does not exist in release builds.
#[cfg(debug_assertions)]
#[tauri::command]
fn selftest_report(window: tauri::Window, report: String) -> ApiResult<()> {
    use std::io::Write;

    main_window_only!(window);
    let (code, line) = selftest_outcome(&report);
    {
        let mut out = std::io::stdout().lock();
        let _ = writeln!(out, "{}", line);
        let _ = out.flush();
    }
    logs::shutdown(); // `process::exit` skips RunEvent::Exit, and the `log stream` child must not stay behind
    std::process::exit(code);
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
    let new_window = MenuItemBuilder::with_id("new-window", "New Window").accelerator("CmdOrCtrl+N").build(app)?;
    let app_menu = SubmenuBuilder::new(app, "Mac Dash")
        .item(&about)
        .separator()
        .item(&new_window)
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
    app.on_menu_event(move |app, event| match event.id().as_ref() {
        "about" => show_about_window(app.clone()),
        "new-window" => {
            if let Err(e) = windows::create_dashboard_window(app) {
                eprintln!("[windows] Could not create a dashboard window: {}", e);
            }
        }
        _ => {}
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
            if !windows::is_dashboard_label(window.label()) {
                return;
            }
            match event {
                // Close to tray: the LAST dashboard window is hidden and the monitor keeps running.
                // Every other window just closes. Quit is in the tray menu and the app menu.
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    if windows::hide_instead_of_close(window) {
                        api.prevent_close();
                    }
                    windows::sync_log_stream(window.app_handle(), None);
                }
                // A closed window does not count any more: the windows that are left may all be hidden.
                tauri::WindowEvent::Destroyed => windows::sync_log_stream(window.app_handle(), Some(window.label())),
                tauri::WindowEvent::Focused(true) => windows::sync_log_stream(window.app_handle(), None),
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
            delete_helper_tool,
            reset_background_items,
            browse_path,
            get_default_path,
            get_job_plists,
            get_job_signature,
            get_background_items,
            delete_login_item,
            build_script_app,
            get_power_schedule,
            set_power_schedule,
            get_monitor_settings,
            set_monitor_settings,
            #[cfg(debug_assertions)]
            selftest_report,
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
        tauri::RunEvent::Reopen { has_visible_windows: false, .. } => windows::show_dashboard(app_handle),
        // The `log stream` child must not outlive the app.
        tauri::RunEvent::Exit => logs::shutdown(),
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selftest_exit_codes() {
        assert_eq!(selftest_outcome(r#"{"ok":true,"checks":12}"#), (0, r#"SELFTEST_REPORT {"ok":true,"checks":12}"#.to_string()));
        assert_eq!(selftest_outcome(r#"{"ok":false,"failed":["save_job"]}"#).0, 1);
        assert_eq!(selftest_outcome(r#"{"checks":3}"#).0, 1);
        assert_eq!(selftest_outcome(r#"{"ok":"true"}"#).0, 1);
        assert_eq!(selftest_outcome("[]").0, 1);
        assert_eq!(selftest_outcome("not json").0, 2);
        assert_eq!(selftest_outcome("").0, 2);

        // Always one line, whatever the client sends.
        let (code, line) = selftest_outcome("{\n  \"ok\": true,\n  \"note\": \"a\\nb\"\n}");
        assert_eq!(code, 0);
        assert_eq!(line.lines().count(), 1);
        assert_eq!(selftest_outcome("broken\nreport\r\n").1, "SELFTEST_REPORT broken report  ");
    }

    #[test]
    fn external_links_are_an_exact_allowlist() {
        assert!(EXTERNAL_URLS.iter().all(|url| url.starts_with("https://")));
        assert!(!EXTERNAL_URLS.contains(&"https://github.com/talhaorak/mac-dash/"));
        assert!(!EXTERNAL_URLS.contains(&"file:///etc/passwd"));
    }
}
