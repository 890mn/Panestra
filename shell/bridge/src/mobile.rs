use serde_json::{json, Value};
use std::collections::HashMap;
use tauri::{plugin::PluginHandle, AppHandle, Runtime, State};
pub struct Bridge<R: Runtime>(pub PluginHandle<R>);
#[tauri::command]
pub async fn scan_pairing<R: Runtime>(_app: AppHandle<R>, bridge: State<'_, Bridge<R>>) -> Result<Value, String> {
    bridge.0.run_mobile_plugin_async("scanPairing", ()).await.map_err(|e| e.to_string())
}
#[tauri::command]
pub fn identity<R: Runtime>(
    _app: AppHandle<R>,
    bridge: State<'_, Bridge<R>>,
) -> Result<Value, String> {
    bridge
        .0
        .run_mobile_plugin("identity", ())
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn sign<R: Runtime>(
    _app: AppHandle<R>,
    bridge: State<'_, Bridge<R>>,
    message: String,
) -> Result<String, String> {
    bridge
        .0
        .run_mobile_plugin("sign", json!({"message":message}))
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn discover<R: Runtime>(
    _app: AppHandle<R>,
    bridge: State<'_, Bridge<R>>,
) -> Result<Value, String> {
    bridge
        .0
        .run_mobile_plugin("discover", ())
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn request<R: Runtime>(
    _app: AppHandle<R>,
    bridge: State<'_, Bridge<R>>,
    endpoint: String,
    path: String,
    method: String,
    body: String,
    headers: HashMap<String, String>,
    fingerprint: String,
) -> Result<Value, String> {
    bridge.0.run_mobile_plugin("request", json!({"endpoint":endpoint,"path":path,"method":method,"body":body,"headers":headers,"fingerprint":fingerprint})).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn connect<R: Runtime>(
    _app: AppHandle<R>,
    bridge: State<'_, Bridge<R>>,
    endpoint: String,
    fingerprint: String,
    token: String,
    last_server_seq: u64,
    topics: Vec<String>,
    connection_id: String,
) -> Result<Value, String> {
    bridge.0.run_mobile_plugin("connect", json!({"endpoint":endpoint,"fingerprint":fingerprint,"token":token,"lastServerSeq":last_server_seq,"topics":topics,"connectionId":connection_id})).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn disconnect<R: Runtime>(
    _app: AppHandle<R>,
    bridge: State<'_, Bridge<R>>,
    connection_id: String,
) -> Result<Value, String> {
    bridge
        .0
        .run_mobile_plugin("disconnect", json!({"connectionId":connection_id}))
        .map_err(|e| e.to_string())
}
