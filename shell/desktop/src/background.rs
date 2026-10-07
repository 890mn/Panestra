use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    Manager,
};

#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Preferences {
    start_in_background: bool,
    close_to_background: bool,
}

pub struct DesktopMode {
    preferences: Mutex<Preferences>,
    path: PathBuf,
    background: AtomicBool,
    config: tauri::utils::config::WindowConfig,
    // Keep the tray alive after setup, including when the last WebView is destroyed.
    tray: Mutex<Option<TrayIcon>>,
}

pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::var_os("PANESTRA_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or(app.path().app_data_dir()?);
    std::fs::create_dir_all(&root)?;
    let path = root.join("desktop-mode.json");
    let preferences: Preferences = match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Preferences::default(),
        Err(error) => return Err(error.into()),
    };
    let background =
        preferences.start_in_background || std::env::args().any(|arg| arg == "--background");
    app.manage(DesktopMode {
        preferences: Mutex::new(preferences),
        path,
        background: AtomicBool::new(background),
        config: app.config().app.windows[0].clone(),
        tray: Mutex::new(None),
    });
    let open = MenuItem::with_id(app, "open", "打开 Panestra", true, None::<&str>)?;
    let service = MenuItem::with_id(app, "background", "切换为后台模式", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let exit = MenuItem::with_id(app, "exit", "退出 Panestra", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &service, &separator, &exit])?;
    let tray = TrayIconBuilder::with_id("panestra-service")
        .icon(
            app.default_window_icon()
                .ok_or("Missing application icon")?
                .clone(),
        )
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Panestra · Core 服务运行中")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => report(app, open_window(app)),
            "background" => report(app, enter_background(app)),
            "exit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                report(tray.app_handle(), open_window(tray.app_handle()));
            }
        })
        .build(app)?;
    *app.state::<DesktopMode>()
        .tray
        .lock()
        .map_err(|_| "Desktop mode unavailable")? = Some(tray);
    if !background {
        open_window(app.handle())?;
    }
    Ok(())
}

fn report(app: &tauri::AppHandle, result: Result<(), String>) {
    if let Err(error) = result {
        eprintln!("Panestra desktop mode: {error}");
        if let Some(tray) = app.tray_by_id("panestra-service") {
            let _ = tray.set_tooltip(Some("Panestra · 界面打开失败，请重试"));
        }
    }
}

pub fn reopen(app: &tauri::AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || report(&handle, open_window(&handle)));
}

fn open_window(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<DesktopMode>();
    let window = if let Some(window) = app.get_webview_window("main") {
        window
    } else {
        tauri::WebviewWindowBuilder::from_config(app, &state.config)
            .map_err(|error| error.to_string())?
            .build()
            .map_err(|error| error.to_string())?
    };
    window.show().map_err(|error| error.to_string())?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    state.background.store(false, Ordering::SeqCst);
    if let Some(tray) = app.tray_by_id("panestra-service") {
        let _ = tray.set_tooltip(Some("Panestra · Core 服务运行中"));
    }
    Ok(())
}

fn enter_background(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<DesktopMode>();
    state.background.store(true, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window("main") {
        if let Err(error) = window.destroy() {
            state.background.store(false, Ordering::SeqCst);
            return Err(error.to_string());
        }
        tauri_plugin_panestra_bridge::disconnect_all(app);
    }
    Ok(())
}

pub fn window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if window.label() != "main" {
        return;
    }
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        let app = window.app_handle();
        let Some(state) = app.try_state::<DesktopMode>() else {
            return;
        };
        let close_to_background = state
            .preferences
            .lock()
            .map(|preferences| preferences.close_to_background)
            .unwrap_or(false);
        if close_to_background {
            api.prevent_close();
            report(app, enter_background(app));
        }
    }
}

pub fn run_event(app: &tauri::AppHandle, event: &tauri::RunEvent) {
    if let tauri::RunEvent::ExitRequested {
        code: None, api, ..
    } = event
    {
        if app.state::<DesktopMode>().background.load(Ordering::SeqCst) {
            api.prevent_exit();
        }
    }
}

#[tauri::command]
pub fn desktop_mode_info(state: tauri::State<DesktopMode>) -> Result<Preferences, String> {
    state
        .preferences
        .lock()
        .map(|value| value.clone())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn configure_desktop_mode(
    state: tauri::State<DesktopMode>,
    preferences: Preferences,
) -> Result<Preferences, String> {
    let mut current = state
        .preferences
        .lock()
        .map_err(|error| error.to_string())?;
    // Persist before acknowledging the switch; a failed write leaves active preferences unchanged.
    let temporary = state.path.with_extension("json.tmp");
    let persist = || -> Result<(), std::io::Error> {
        use std::io::Write;
        let mut file = std::fs::File::create(&temporary)?;
        file.write_all(&serde_json::to_vec(&preferences)?)?;
        file.sync_all()?;
        std::fs::rename(&temporary, &state.path)
    };
    if let Err(error) = persist() {
        let _ = std::fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    *current = preferences.clone();
    Ok(preferences)
}

#[tauri::command]
pub async fn enter_background_mode(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (send, receive) = std::sync::mpsc::channel();
        let handle = app.clone();
        app.run_on_main_thread(move || {
            let _ = send.send(enter_background(&handle));
        })
        .map_err(|error| error.to_string())?;
        receive.recv().map_err(|error| error.to_string())?
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn exit_desktop_app(app: tauri::AppHandle) {
    app.exit(0);
}
