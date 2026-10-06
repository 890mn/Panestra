use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};
#[cfg(not(target_os = "android"))]
mod desktop;
#[cfg(target_os = "android")]
mod mobile;

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    let builder = Builder::<R, ()>::new("panestra-bridge");
    #[cfg(not(target_os = "android"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        desktop::identity,
        desktop::sign,
        desktop::discover,
        desktop::request,
        desktop::connect,
        desktop::disconnect,
        desktop::open_github
    ]);
    #[cfg(target_os = "android")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        mobile::identity,
        mobile::scan_pairing,
        mobile::sign,
        mobile::discover,
        mobile::request,
        mobile::connect,
        mobile::disconnect,
        mobile::open_github
    ]);
    builder
        .setup(|app, api| {
            #[cfg(not(target_os = "android"))]
            {
                let _ = api;
                app.manage(desktop::Connections::default());
            }
            #[cfg(target_os = "android")]
            {
                let handle =
                    api.register_android_plugin("dev.panestra.bridge", "PanestraBridgePlugin")?;
                app.manage(mobile::Bridge(handle));
            }
            Ok(())
        })
        .build()
}
