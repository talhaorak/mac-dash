//! Dashboard windows. See "Windows (desktop only)" in docs/backend-contract.md.
//!
//! The first window has the label `main`. "New Window" adds `main-2`, `main-3`, …. Only this file
//! creates them: the capability file gives the web view no permission to create windows.
//! Closing the last dashboard window hides it (the app stays in the tray), the others just close.

use tauri::{AppHandle, Manager, WebviewWindow, WebviewWindowBuilder};

pub const MAIN_WINDOW: &str = "main";
const EXTRA_PREFIX: &str = "main-";
/// New windows open a little below and to the right of the focused one, in logical pixels.
const CASCADE_OFFSET: f64 = 28.0;

/// The number in a dashboard label: 1 for `main`, n for `main-<n>`. None for every other window.
fn dashboard_number(label: &str) -> Option<u32> {
    if label == MAIN_WINDOW {
        return Some(1);
    }
    let digits = label.strip_prefix(EXTRA_PREFIX)?;
    let plain = !digits.is_empty() && digits.len() <= 6 && digits.bytes().all(|b| b.is_ascii_digit()) && !digits.starts_with('0');
    digits.parse().ok().filter(|n| plain && *n >= 2)
}

/// `main` and `main-<n>`. The command guard, the events and close-to-tray all use this one rule.
pub fn is_dashboard_label(label: &str) -> bool {
    dashboard_number(label).is_some()
}

/// The lowest free label: `main` when it is gone, else `main-2`, `main-3`, ….
fn next_dashboard_label<'a>(existing: impl IntoIterator<Item = &'a str>) -> String {
    let taken: Vec<u32> = existing.into_iter().filter_map(dashboard_number).collect();
    match (1..).find(|n| !taken.contains(n)) {
        Some(1) | None => MAIN_WINDOW.to_string(),
        Some(n) => format!("{}{}", EXTRA_PREFIX, n),
    }
}

/// The label of `main`, then the extra windows by number. `closing` leaves one label out.
fn order_dashboard_labels<'a>(labels: impl IntoIterator<Item = &'a str>, closing: Option<&str>) -> Vec<String> {
    let mut numbered: Vec<(u32, &str)> =
        labels.into_iter().filter(|label| Some(*label) != closing).filter_map(|label| Some((dashboard_number(label)?, label))).collect();
    numbered.sort();
    numbered.into_iter().map(|(_, label)| label.to_string()).collect()
}

/// Every dashboard window, `main` first. `closing`: a window that is going away and does not count.
pub fn dashboard_windows(app: &AppHandle, closing: Option<&str>) -> Vec<WebviewWindow> {
    let windows = app.webview_windows();
    order_dashboard_labels(windows.keys().map(String::as_str), closing).iter().filter_map(|label| windows.get(label).cloned()).collect()
}

/// Nobody reads the log buffer while no dashboard window is visible, so the `log stream` child pauses.
pub fn sync_log_stream(app: &AppHandle, closing: Option<&str>) {
    let visible = dashboard_windows(app, closing).iter().filter(|window| window.is_visible().unwrap_or(true)).count();
    if visible > 0 {
        crate::logs::resume_log_stream();
    } else {
        crate::logs::pause_log_stream();
    }
}

/// A new dashboard window with the configuration of the main window: size, minimum size, overlay
/// title bar, hidden title and the same URL (the dev server in `cargo tauri dev`).
pub fn create_dashboard_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let existing = app.webview_windows();
    let label = next_dashboard_label(existing.keys().map(String::as_str));
    let mut config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == MAIN_WINDOW)
        .or_else(|| app.config().app.windows.first())
        .cloned()
        .ok_or(tauri::Error::WindowNotFound)?;
    config.label = label;

    let mut builder = WebviewWindowBuilder::from_config(app, &config)?;
    // Cascade from the focused window, so that the new one does not cover it exactly.
    let focused = dashboard_windows(app, None).into_iter().find(|window| window.is_focused().unwrap_or(false));
    if let Some((position, scale)) = focused.and_then(|window| Some((window.outer_position().ok()?, window.scale_factor().ok()?))) {
        let logical = position.to_logical::<f64>(scale);
        builder = builder.position(logical.x + CASCADE_OFFSET, logical.y + CASCADE_OFFSET);
    }
    let window = builder.build()?;
    let _ = window.set_focus();
    sync_log_stream(app, None);
    Ok(window)
}

/// Tray "Show Dashboard" and a click on the Dock icon: show the first dashboard window.
/// When none exists any more, `main` is created again.
pub fn show_dashboard(app: &AppHandle) {
    match dashboard_windows(app, None).into_iter().next() {
        Some(window) => {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
        None => {
            if let Err(e) = create_dashboard_window(app) {
                eprintln!("[windows] Could not create a dashboard window: {}", e);
            }
        }
    }
    sync_log_stream(app, None);
}

/// `WindowEvent::CloseRequested` of a dashboard window. Returns true when the window must stay:
/// it is the last one, so it is hidden and the app keeps running in the tray.
pub fn hide_instead_of_close(window: &tauri::Window) -> bool {
    let app = window.app_handle();
    let is_last = dashboard_windows(app, Some(window.label())).is_empty();
    if is_last {
        let _ = window.hide();
    }
    is_last
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dashboard_labels() {
        for label in ["main", "main-2", "main-3", "main-10", "main-999999"] {
            assert!(is_dashboard_label(label), "{}", label);
        }
        // The About window and anything that only looks similar get no dashboard rights.
        for label in ["about", "", "Main", "main-", "main-1", "main-0", "main-02", "main-x", "main-2x", "main--2", "main-2-3", "xmain", "main2", "main-1000000", "main-٢"] {
            assert!(!is_dashboard_label(label), "{:?}", label);
        }
    }

    #[test]
    fn next_labels() {
        assert_eq!(next_dashboard_label(["main"]), "main-2");
        assert_eq!(next_dashboard_label(["main", "about", "main-2"]), "main-3");
        // A closed window frees its number, and a lost `main` comes back first.
        assert_eq!(next_dashboard_label(["main", "main-3"]), "main-2");
        assert_eq!(next_dashboard_label(["main-2", "about"]), "main");
        assert_eq!(next_dashboard_label([]), "main");
        assert!(is_dashboard_label(&next_dashboard_label(["main", "main-2", "main-3", "main-4"])));
    }

    #[test]
    fn window_order_and_last_window() {
        assert_eq!(order_dashboard_labels(["main-10", "about", "main-2", "main"], None), vec!["main", "main-2", "main-10"]);
        // Close-to-tray: the closing window does not count. It is the last one when nothing else is left.
        assert_eq!(order_dashboard_labels(["main", "about"], Some("main")), Vec::<String>::new());
        assert_eq!(order_dashboard_labels(["main", "main-2"], Some("main")), vec!["main-2"]);
        assert_eq!(order_dashboard_labels(["main-2", "about"], Some("about")), vec!["main-2"]);
    }
}
