const COMMANDS: &[&str] = &[
    "identity",
    "scan_pairing",
    "sign",
    "discover",
    "request",
    "connect",
    "disconnect",
    "open_github",
];
fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
