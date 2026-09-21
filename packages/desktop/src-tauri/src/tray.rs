use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

/// `app.trayIcon` in tauri.conf.json already creates the tray icon with this id.
/// Building a second one would put an extra, empty item in the menu bar.
const TRAY_ID: &str = "main";

pub fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let quit = MenuItemBuilder::with_id("quit", "Quit Mac Dash").build(app)?;
    let show = MenuItemBuilder::with_id("show", "Show Dashboard").build(app)?;

    let menu = MenuBuilder::new(app)
        .item(&show)
        .separator()
        .item(&quit)
        .build()?;

    let tray = match app.tray_by_id(TRAY_ID) {
        Some(tray) => tray,
        None => {
            let mut builder = TrayIconBuilder::with_id(TRAY_ID).tooltip("Mac Dash").icon_as_template(true);
            if let Some(icon) = app.default_window_icon() {
                builder = builder.icon(icon.clone());
            }
            builder.build(app)?
        }
    };

    tray.set_menu(Some(menu))?;
    // Left click shows the dashboard, right click opens the menu.
    tray.set_show_menu_on_left_click(false)?;
    tray.on_menu_event(|app, event| match event.id().as_ref() {
        // Closing the window only hides it, so this is the way out besides the app menu.
        "quit" => app.exit(0),
        "show" => crate::windows::show_dashboard(app),
        _ => {}
    });
    tray.on_tray_icon_event(|tray, event| {
        if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
            crate::windows::show_dashboard(tray.app_handle());
        }
    });

    Ok(())
}
