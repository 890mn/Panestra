const COMMANDS: &[&str] = &[
    "identity",
    "scan_pairing",
    "sign",
    "discover",
    "request",
    "probe_endpoint",
    "connect",
    "disconnect",
    "open_github",
    "install_app_update",
];
fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
