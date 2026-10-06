use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::{SinkExt, StreamExt};
use p256::{
    ecdsa::{signature::Signer, Signature, SigningKey},
    pkcs8::{DecodePrivateKey, EncodePrivateKey, EncodePublicKey},
};
use rustls::{
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    pki_types::{CertificateDer, ServerName, UnixTime},
    DigitallySignedStruct, SignatureScheme,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime},
};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tokio::sync::oneshot;
use tokio_tungstenite::{tungstenite::Message, Connector};

#[derive(Default)]
pub struct Connections(Mutex<HashMap<String, oneshot::Sender<()>>>);

#[tauri::command]
pub async fn open_github() -> Result<(), String> {
    // Browser activation may wait for another process. Never run it on the
    // WebView UI thread, where ShellExecute can block message delivery.
    tokio::time::timeout(
        Duration::from_secs(15),
        tauri::async_runtime::spawn_blocking(open_project_browser),
    )
    .await
    .map_err(|_| "浏览器响应超时，请稍后重试".to_string())?
    .map_err(|_| "无法打开浏览器，请稍后重试".to_string())?
}

fn open_project_browser() -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::{
            System::Com::{
                CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
            },
            UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
        };
        let url: Vec<u16> = "https://github.com/890mn/Panestra"
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let initialized = unsafe {
            CoInitializeEx(
                std::ptr::null(),
                (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32,
            )
        };
        let opened = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                std::ptr::null(),
                url.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        };
        if initialized >= 0 {
            unsafe { CoUninitialize() };
        }
        if opened as isize <= 32 {
            return Err("无法打开浏览器，请访问 github.com/890mn/Panestra".into());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    Err("此平台暂不支持打开项目页面".into())
}
#[derive(Serialize, Deserialize)]
struct StoredKey {
    device_id: String,
    pkcs8: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    device_id: String,
    public_key: String,
}

#[cfg(windows)]
fn protect(data: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        if encrypt {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if ok == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let result =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(output.pbData as *mut _);
    }
    Ok(result)
}
#[cfg(not(windows))]
fn protect(_: &[u8], _: bool) -> Result<Vec<u8>, String> {
    Err("Desktop secure storage requires Windows".into())
}
fn key<R: Runtime>(app: &AppHandle<R>) -> Result<(String, SigningKey), String> {
    static KEY_LOCK: Mutex<()> = Mutex::new(());
    let _lock = KEY_LOCK.lock().map_err(|e| e.to_string())?;
    let dir = std::env::var_os("PANESTRA_DATA_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or(app.path().app_data_dir().map_err(|e| e.to_string())?);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("device.protected");
    if path.exists() {
        let stored: StoredKey = serde_json::from_slice(&protect(
            &fs::read(path).map_err(|e| e.to_string())?,
            false,
        )?)
        .map_err(|e| e.to_string())?;
        let signing =
            SigningKey::from_pkcs8_der(&STANDARD.decode(stored.pkcs8).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        return Ok((stored.device_id, signing));
    }
    let signing = SigningKey::random(&mut rand_core::OsRng);
    let id = uuid::Uuid::new_v4().to_string();
    let stored = StoredKey {
        device_id: id.clone(),
        pkcs8: STANDARD.encode(
            signing
                .to_pkcs8_der()
                .map_err(|e| e.to_string())?
                .as_bytes(),
        ),
    };
    fs::write(
        path,
        protect(
            &serde_json::to_vec(&stored).map_err(|e| e.to_string())?,
            true,
        )?,
    )
    .map_err(|e| e.to_string())?;
    Ok((id, signing))
}
#[tauri::command]
pub fn identity<R: Runtime>(app: AppHandle<R>) -> Result<Identity, String> {
    let (device_id, signing) = key(&app)?;
    let public_key = STANDARD.encode(
        signing
            .verifying_key()
            .to_public_key_der()
            .map_err(|e| e.to_string())?
            .as_bytes(),
    );
    Ok(Identity {
        device_id,
        public_key,
    })
}
#[tauri::command]
pub fn sign<R: Runtime>(app: AppHandle<R>, message: String) -> Result<String, String> {
    if !message.starts_with("panestra:v1:") || message.len() > 4096 {
        return Err("Invalid challenge".into());
    }
    let (_, signing) = key(&app)?;
    let signature: Signature = signing.sign(message.as_bytes());
    Ok(STANDARD.encode(signature.to_bytes()))
}
#[derive(Debug)]
struct PinnedVerifier {
    fingerprint: String,
    provider: rustls::crypto::CryptoProvider,
}
impl ServerCertVerifier for PinnedVerifier {
    fn verify_server_cert(
        &self,
        end: &CertificateDer<'_>,
        _: &[CertificateDer<'_>],
        _: &ServerName<'_>,
        _: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        use x509_parser::prelude::parse_x509_certificate;
        let (_, certificate) = parse_x509_certificate(end.as_ref())
            .map_err(|_| rustls::Error::General("Invalid Core certificate".into()))?;
        let hash = format!("{:x}", Sha256::digest(certificate.public_key().raw));
        if hash != self.fingerprint
            || (now.as_secs() as i64) < certificate.validity().not_before.timestamp()
            || (now.as_secs() as i64) > certificate.validity().not_after.timestamp()
        {
            return Err(rustls::Error::General(
                "Core identity or certificate validity mismatch".into(),
            ));
        }
        Ok(ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }
    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}
fn tls(fingerprint: &str) -> Result<rustls::ClientConfig, String> {
    let fp = fingerprint.to_ascii_lowercase();
    if fp.len() != 64 || !fp.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Core SHA-256 fingerprint required".into());
    }
    let provider = rustls::crypto::ring::default_provider();
    let builder = rustls::ClientConfig::builder_with_provider(Arc::new(provider.clone()))
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|e| e.to_string())?;
    Ok(builder
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(PinnedVerifier {
            fingerprint: fp,
            provider,
        }))
        .with_no_client_auth())
}
fn endpoint_url(endpoint: &str, path: &str) -> Result<url::Url, String> {
    let base = url::Url::parse(endpoint).map_err(|e| e.to_string())?;
    if base.scheme() != "https"
        || !base.username().is_empty()
        || base.password().is_some()
        || base.path() != "/"
        || base.query().is_some()
        || base.fragment().is_some()
    {
        return Err("Invalid HTTPS Core endpoint".into());
    }
    if !path.starts_with("/api/v1/") && path != "/ws/v1" {
        return Err("Only Panestra API paths are allowed".into());
    }
    base.join(path).map_err(|e| e.to_string())
}
#[derive(Serialize)]
pub struct Response {
    status: u16,
    body: String,
}
#[tauri::command]
pub async fn request(
    endpoint: String,
    path: String,
    method: String,
    body: String,
    headers: HashMap<String, String>,
    fingerprint: String,
) -> Result<Response, String> {
    if body.len() > 65536 || (method != "GET" && method != "POST") {
        return Err("Invalid request".into());
    }
    let url = endpoint_url(&endpoint, &path)?;
    let client = reqwest::Client::builder()
        .use_preconfigured_tls(tls(&fingerprint)?)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.request(
        reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?,
        url,
    );
    for (k, v) in headers {
        if k.eq_ignore_ascii_case("authorization") || k.eq_ignore_ascii_case("content-type") {
            req = req.header(k, v);
        }
    }
    let response = req.body(body).send().await.map_err(|e| e.to_string())?;
    let status = response.status().as_u16();
    if response.content_length().unwrap_or(0) > 8 * 1024 * 1024 {
        return Err("Response too large".into());
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        if bytes.len() + chunk.len() > 8 * 1024 * 1024 {
            return Err("Response too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(Response {
        status,
        body: String::from_utf8(bytes).map_err(|e| e.to_string())?,
    })
}
#[tauri::command]
pub async fn connect<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Connections>,
    endpoint: String,
    fingerprint: String,
    token: String,
    last_server_seq: u64,
    topics: Vec<String>,
    connection_id: String,
) -> Result<(), String> {
    let mut url = endpoint_url(&endpoint, "/ws/v1")?;
    url.set_scheme("wss").map_err(|_| "Invalid scheme")?;
    let connector = Connector::Rustls(Arc::new(tls(&fingerprint)?));
    let (mut socket, _) = tokio_tungstenite::connect_async_tls_with_config(
        url.as_str(),
        Some(
            tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
                .max_message_size(Some(8 * 1024 * 1024)),
        ),
        false,
        Some(connector),
    )
    .await
    .map_err(|e| e.to_string())?;
    socket
        .send(Message::Text(
            serde_json::json!({"type":"auth","token":token,"lastServerSeq":last_server_seq})
                .to_string()
                .into(),
        ))
        .await
        .map_err(|e| e.to_string())?;
    socket
        .send(Message::Text(
            serde_json::json!({"type":"subscribe","topics":topics})
                .to_string()
                .into(),
        ))
        .await
        .map_err(|e| e.to_string())?;
    let (stop, mut stopped) = oneshot::channel();
    state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .insert(connection_id.clone(), stop);
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! { _ = &mut stopped => break, next = socket.next() => match next { Some(Ok(Message::Text(data))) => { let _ = app.emit("panestra:message", serde_json::json!({"connectionId":connection_id,"data":data.as_str()})); }, Some(Ok(Message::Ping(data))) => { if socket.send(Message::Pong(data)).await.is_err() { break; } }, Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break, _ => {} } }
        }
        let _ = socket.close(None).await;
        app.state::<Connections>()
            .0
            .lock()
            .ok()
            .map(|mut connections| connections.remove(&connection_id));
        let _ = app.emit(
            "panestra:closed",
            serde_json::json!({"connectionId":connection_id}),
        );
    });
    Ok(())
}
#[tauri::command]
pub fn disconnect(state: State<'_, Connections>, connection_id: String) {
    if let Ok(mut all) = state.0.lock() {
        if let Some(stop) = all.remove(&connection_id) {
            let _ = stop.send(());
        }
    }
}
#[tauri::command]
pub async fn discover() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let daemon = mdns_sd::ServiceDaemon::new().map_err(|e| e.to_string())?;
        let receiver = daemon.browse("_panestra._tcp.local.").map_err(|e| e.to_string())?;
        let until = SystemTime::now() + Duration::from_secs(3); let mut found = Vec::new();
        while SystemTime::now() < until { if let Ok(mdns_sd::ServiceEvent::ServiceResolved(info)) = receiver.recv_timeout(Duration::from_millis(200)) { for ip in info.get_addresses() { let address = if ip.is_ipv6() { format!("[{}]", ip) } else { ip.to_string() }; found.push(serde_json::json!({"uri":format!("https://{}:{}",address,info.get_port()),"name":info.get_fullname(),"serverIdHint":info.get_property_val_str("id")})); } } }
        let _ = daemon.shutdown(); Ok(serde_json::Value::Array(found))
    }).await.map_err(|e| e.to_string())?
}
