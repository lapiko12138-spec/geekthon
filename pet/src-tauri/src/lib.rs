use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager,
};

// Show (and focus) the main window, or hide it if already visible.
fn toggle_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_visible().unwrap_or(true) {
            let _ = w.hide();
        } else {
            let _ = w.show();
            let _ = w.set_focus();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // ── System tray: the only reliable way to quit / re-open settings,
            //    especially on Windows where the window has no taskbar entry
            //    or title-bar close button (skipTaskbar + decorations:false). ──
            let settings_i = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?;
            let toggle_i = MenuItem::with_id(app, "toggle", "显示 / 隐藏", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "退出麦麦", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&settings_i, &toggle_i, &quit_i])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().expect("no default icon").clone())
                .tooltip("麦麦桌宠")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "settings" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                        // Tell the frontend to open the wizard in "settings" mode.
                        let _ = app.emit("open-settings", ());
                    }
                    "toggle" => toggle_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
