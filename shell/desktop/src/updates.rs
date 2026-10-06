use tauri::{ipc::Channel, AppHandle, Manager};
use tauri_plugin_updater::UpdaterExt;

// Installation is invoked by the user's update button, never at startup.
#[tauri::command]
pub async fn install_app_update(
    app: AppHandle,
    expected_version: String,
    progress: Channel<Option<u64>>,
) -> Result<(), String> {
    let parts = expected_version
        .split('.')
        .map(str::parse::<u64>)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "更新版本格式不正确")?;
    if parts.len() != 3 {
        return Err("更新版本格式不正确".into());
    }
    let current = &app.package_info().version;
    if (parts[0], parts[1], parts[2]) <= (current.major, current.minor, current.patch) {
        return Err("当前没有可安装的更新".into());
    }
    let lock = app.state::<UpdateLock>();
    if lock.0.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return Err("更新已在进行中".into());
    }
    let _guard = UpdateGuard(&lock.0);
    let before_exit = app.clone();
    let update = app
        .updater_builder()
        .timeout(std::time::Duration::from_secs(600))
        .on_before_exit(move || {
            crate::shutdown_core(&before_exit);
            before_exit.cleanup_before_exit();
        })
        .build()
        .map_err(|_| "无法初始化更新器")?
        .check()
        .await
        .map_err(|_| "无法读取签名更新信息，请稍后重试")?
        .ok_or("当前没有可安装的更新")?;
    if update.version != expected_version {
        return Err("发布版本已变化，请重新检查更新".into());
    }
    if update.download_url.scheme() != "https"
        || update.download_url.host_str() != Some("github.com")
        || !update
            .download_url
            .path()
            .starts_with("/890mn/Panestra/releases/download/")
    {
        return Err("更新地址不可信".into());
    }
    let mut received = 0_u64;
    let bytes = update
        .download(
            |size, total| {
                received += size as u64;
                let value = total
                    .filter(|n| *n > 0)
                    .map(|n| (received * 100 / n).min(100));
                let _ = progress.send(value);
            },
            || {},
        )
        .await
        .map_err(|_| "更新下载或签名校验失败，当前版本未更改")?;
    // The official installer restarts the application. Its before-exit hook stops
    // Core only after the signed bundle has been verified and extracted.
    update
        .install(bytes)
        .map_err(|_| "无法启动安装程序，请稍后重试".to_string())
}

#[derive(Default)]
pub struct UpdateLock(pub std::sync::atomic::AtomicBool);

struct UpdateGuard<'a>(&'a std::sync::atomic::AtomicBool);
impl Drop for UpdateGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}
