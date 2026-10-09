#[cfg(not(target_os = "android"))]
use std::{
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
    sync::Mutex,
};
use tauri::Manager;

#[cfg(windows)]
mod background;
#[cfg(windows)]
mod updates;

#[derive(Clone, serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct LocalCoreInfo {
    endpoint: String,
    fingerprint: String,
    bootstrap_code: String,
}
#[derive(Default)]
struct LocalCore(std::sync::Mutex<LocalCoreInfo>);
#[tauri::command]
fn local_core_info(state: tauri::State<LocalCore>) -> LocalCoreInfo {
    state.0.lock().map(|v| v.clone()).unwrap_or_default()
}

#[cfg(not(target_os = "android"))]
struct CoreProcess(Mutex<Option<Child>>);
#[cfg(not(target_os = "android"))]
fn stop_core(mut child: Child) {
    drop(child.stdin.take());
    for _ in 0..60 {
        if child.try_wait().ok().flatten().is_some() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    let _ = child.kill();
    let _ = child.wait();
}
#[cfg(not(target_os = "android"))]
impl Drop for CoreProcess {
    fn drop(&mut self) {
        if let Ok(child) = self.0.get_mut() {
            if let Some(child) = child.take() {
                stop_core(child);
            }
        }
    }
}

#[cfg(not(target_os = "android"))]
fn shutdown_core(app: &tauri::AppHandle) {
    if let Ok(mut child) = app.state::<CoreProcess>().0.lock() {
        if let Some(child) = child.take() {
            stop_core(child);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(windows)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _| {
        if !args.iter().any(|arg| arg == "--background") {
            background::reopen(app);
        }
    }));
    let builder = builder.plugin(tauri_plugin_panestra_bridge::init());
    #[cfg(windows)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(updates::UpdateLock::default())
        .on_window_event(background::window_event)
        .invoke_handler(tauri::generate_handler![
            local_core_info,
            updates::install_app_update,
            background::desktop_mode_info,
            background::configure_desktop_mode,
            background::enter_background_mode,
            background::exit_desktop_app
        ]);
    #[cfg(not(windows))]
    let builder = builder.invoke_handler(tauri::generate_handler![local_core_info]);

    let context = tauri::generate_context!();
    #[cfg(windows)]
    let context = {
        let mut context = context;
        context.config_mut().app.windows[0].create = false;
        // Isolated development/test data roots must not capture the installed application's singleton.
        if let Some(root) = std::env::var_os("PANESTRA_DATA_DIR") {
            use std::hash::{Hash, Hasher};
            let mut hash = std::collections::hash_map::DefaultHasher::new();
            root.hash(&mut hash);
            context
                .config_mut()
                .identifier
                .push_str(&format!(".session{:016x}", hash.finish()));
        }
        context
    };
    builder
        .setup(|app| {
            app.manage(LocalCore::default());
            #[cfg(not(target_os = "android"))]
            {
                let resources = app.path().resource_dir()?;
                let data_root = std::env::var_os("PANESTRA_DATA_DIR")
                    .map(std::path::PathBuf::from)
                    .unwrap_or(app.path().app_data_dir()?);
                let data = data_root.join("core");
                std::fs::create_dir_all(&data)?;
                let packaged = resources.join("panestra-core.exe");
                let development = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../artifacts/build/panestra-core.exe");
                let core = if packaged.exists() {
                    packaged
                } else {
                    development
                };
                let plugin_seed = if resources.join("plugin-seed/catalog.json").exists() {
                    resources.join("plugin-seed")
                } else {
                    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                        .join("../../artifacts/build/plugin-seed")
                };
                let mut command = Command::new(core);
                command.args([
                    "--data",
                    data.to_str().ok_or("Invalid data path")?,
                    "--plugin-seed",
                    plugin_seed.to_str().ok_or("Invalid plugin seed path")?,
                    "--origins",
                    "http://tauri.localhost,https://tauri.localhost",
                ]);
                command.arg("--listen").arg(
                    std::env::var("PANESTRA_CORE_LISTEN").unwrap_or_else(|_| "0.0.0.0:9443".into()),
                );
                command
                    .arg("--parent-stdio")
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped());
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    command.creation_flags(0x08000000);
                }
                let mut child = command.spawn()?;
                let stdout = child.stdout.take().ok_or("No Core stdout")?;
                let stderr = child.stderr.take().ok_or("No Core stderr")?;
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                        if let Some(code) = line.split(": ").nth(1) {
                            if line.contains("认领码") {
                                if let Ok(mut info) = handle.state::<LocalCore>().0.lock() {
                                    info.bootstrap_code = code.to_string();
                                }
                            }
                        }
                    }
                });
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                            if value["msg"] == "Panestra Core ready" {
                                if let Ok(mut info) = handle.state::<LocalCore>().0.lock() {
                                    info.endpoint =
                                        value["endpoint"].as_str().unwrap_or_default().to_string();
                                    info.fingerprint = value["fingerprint"]
                                        .as_str()
                                        .unwrap_or_default()
                                        .to_string();
                                }
                            }
                        }
                    }
                });
                app.manage(CoreProcess(Mutex::new(Some(child))));
            }
            #[cfg(windows)]
            background::setup(app)?;
            Ok(())
        })
        .build(context)
        .expect("Panestra shell startup failed")
        .run(|_app, _event| {
            #[cfg(windows)]
            background::run_event(_app, &_event);
            #[cfg(not(target_os = "android"))]
            if let tauri::RunEvent::Exit = _event {
                if let Ok(mut child) = _app.state::<CoreProcess>().0.lock() {
                    if let Some(child) = child.take() {
                        stop_core(child);
                    }
                }
            }
        });
}
