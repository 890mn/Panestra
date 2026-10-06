package dev.panestra.bridge

import android.app.Activity
import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Handler
import android.os.Looper
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.ActivityCallback
import androidx.activity.result.ActivityResult
import com.journeyapps.barcodescanner.ScanOptions
import com.journeyapps.barcodescanner.ScanIntentResult
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.net.URI
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.Signature
import java.security.cert.X509Certificate
import java.security.spec.ECGenParameterSpec
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

@TauriPlugin
class PanestraBridgePlugin(private val activity: Activity) : Plugin(activity) {
    private val executor = Executors.newCachedThreadPool()
    private val sockets = ConcurrentHashMap<String, WebSocket>()
    private lateinit var surface: WebView
    override fun load(webView: WebView) { surface = webView; if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true) }
    private val alias = "panestra.device.v1"
    @Command fun scanPairing(invoke: Invoke) {
        activity.runOnUiThread {
            try {
                val options = ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                    .setPrompt("扫描电脑 Panestra 的配对二维码")
                    .setBeepEnabled(false).setBarcodeImageEnabled(false).setOrientationLocked(false)
                startActivityForResult(invoke, options.createScanIntent(activity), "pairingScanResult")
            } catch (e: Exception) { invoke.reject(e.message ?: "无法启动相机，请使用手动配对") }
        }
    }
    @ActivityCallback fun pairingScanResult(invoke: Invoke, result: ActivityResult) {
        val text = ScanIntentResult.parseActivityResult(result.resultCode, result.data).contents
        if (text != null && text.length > 4096) { invoke.reject("不是有效的 Panestra 配对二维码"); return }
        invoke.resolve(JSObject().put("text", text ?: JSONObject.NULL))
    }
    private fun store(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    @Synchronized private fun ensureKey(): KeyStore {
        var keys = store()
        if (!keys.containsAlias(alias)) {
            val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
            generator.initialize(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256).setUserAuthenticationRequired(false).build())
            generator.generateKeyPair()
            keys = store()
        }
        return keys
    }
    @Command fun identity(invoke: Invoke) {
        try {
            val keys = ensureKey()
            val prefs = activity.getSharedPreferences("panestra.identity", Context.MODE_PRIVATE)
            val id = prefs.getString("deviceId", null) ?: UUID.randomUUID().toString().also { prefs.edit().putString("deviceId", it).commit() }
            val pub = Base64.encodeToString(keys.getCertificate(alias).publicKey.encoded, Base64.NO_WRAP)
            invoke.resolve(JSObject().put("deviceId", id).put("publicKey", pub))
        } catch (e: Exception) { invoke.reject(e.message ?: "Keystore unavailable") }
    }
    @Command fun sign(invoke: Invoke) {
        try {
            val message = invoke.getArgs().getString("message")
            require(message.startsWith("panestra:v1:") && message.length <= 4096) { "Invalid Core challenge" }
            val signer = Signature.getInstance("SHA256withECDSA")
            signer.initSign(ensureKey().getKey(alias, null) as java.security.PrivateKey)
            signer.update(message.toByteArray(Charsets.UTF_8))
            invoke.resolveObject(Base64.encodeToString(signer.sign(), Base64.NO_WRAP))
        } catch (e: Exception) { invoke.reject(e.message ?: "Signing failed") }
    }
    @Command fun discover(invoke: Invoke) {
        val handler = Handler(Looper.getMainLooper())
        handler.post {
            val manager = activity.getSystemService(Context.NSD_SERVICE) as NsdManager
            val wifi = activity.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            val multicast = wifi.createMulticastLock("panestra.discovery").apply { setReferenceCounted(false); acquire() }
            val found = ConcurrentHashMap<String, JSONObject>()
            val queue = java.util.concurrent.ConcurrentLinkedQueue<NsdServiceInfo>()
            var resolving = false
            var finished = false
            fun resolveNext() {
                if (finished || resolving) return
                val info = queue.poll() ?: return
                resolving = true
                manager.resolveService(info, object : NsdManager.ResolveListener {
                    override fun onResolveFailed(service: NsdServiceInfo, errorCode: Int) { handler.post { resolving = false; resolveNext() } }
                    override fun onServiceResolved(service: NsdServiceInfo) {
                        val host = service.host?.hostAddress ?: ""
                        if (host.isNotEmpty()) {
                            val address = if (host.contains(":")) "[$host]" else host
                            val uri = "https://$address:${service.port}"
                            found[uri] = JSONObject().put("uri", uri).put("name", service.serviceName)
                                .put("serverIdHint", service.attributes["id"]?.toString(Charsets.UTF_8) ?: "")
                        }
                        handler.post { resolving = false; resolveNext() }
                    }
                })
            }
            val listener = object : NsdManager.DiscoveryListener {
                override fun onDiscoveryStarted(type: String) {}
                override fun onDiscoveryStopped(type: String) {}
                override fun onServiceFound(service: NsdServiceInfo) { if (service.serviceType == "_panestra._tcp.") { queue.add(service); handler.post { resolveNext() } } }
                override fun onServiceLost(service: NsdServiceInfo) {}
                override fun onStartDiscoveryFailed(type: String, code: Int) {}
                override fun onStopDiscoveryFailed(type: String, code: Int) {}
            }
            try {
                manager.discoverServices("_panestra._tcp.", NsdManager.PROTOCOL_DNS_SD, listener)
                handler.postDelayed({
                    finished = true
                    try { manager.stopServiceDiscovery(listener) } catch (_: Exception) {}
                    if (multicast.isHeld) multicast.release()
                    invoke.resolveObject(found.values.map { mapOf("uri" to it.getString("uri"), "name" to it.getString("name"), "serverIdHint" to it.getString("serverIdHint")) })
                }, 4000)
            } catch (e: Exception) { if (multicast.isHeld) multicast.release(); invoke.reject(e.message ?: "NSD failed") }
        }
    }
    private fun client(fingerprint: String): OkHttpClient {
        require(fingerprint.matches(Regex("[a-fA-F0-9]{64}"))) { "Core SHA-256 fingerprint required" }
        val manager = object : X509TrustManager {
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
            override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) { throw java.security.cert.CertificateException("Client trust unsupported") }
            override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
                if (chain.isEmpty()) throw java.security.cert.CertificateException("Missing Core certificate")
                chain[0].checkValidity()
                val hash = MessageDigest.getInstance("SHA-256").digest(chain[0].publicKey.encoded).joinToString("") { "%02x".format(it.toInt() and 255) }
                if (!MessageDigest.isEqual(hash.toByteArray(), fingerprint.lowercase().toByteArray())) throw java.security.cert.CertificateException("Core identity mismatch")
            }
        }
        val ssl = SSLContext.getInstance("TLSv1.3").apply { init(null, arrayOf<TrustManager>(manager), null) }
        return OkHttpClient.Builder().sslSocketFactory(ssl.socketFactory, manager)
            .hostnameVerifier { _, _ -> true } // Stable SPKI pin above replaces mutable hostname identity.
            .followRedirects(false).followSslRedirects(false).connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS).build()
    }
    private fun endpoint(endpoint: String, path: String): String {
        val uri = URI(endpoint)
        require(uri.scheme == "https" && uri.host != null && uri.userInfo == null && uri.query == null && uri.fragment == null) { "HTTPS Core endpoint required" }
        require(uri.path.isNullOrEmpty() || uri.path == "/") { "Endpoint must have no path" }
        require(path.startsWith("/api/v1/") || path == "/ws/v1") { "Only Panestra API paths allowed" }
        return endpoint.trimEnd('/') + path
    }
    @Command fun request(invoke: Invoke) {
        executor.execute {
            try {
                val args = invoke.getArgs()
                val method = args.getString("method")
                val body = args.optString("body", "")
                require(method == "GET" || method == "POST")
                require(body.toByteArray().size <= 65536)
                val builder = Request.Builder().url(endpoint(args.getString("endpoint"), args.getString("path")))
                val headers = args.optJSONObject("headers") ?: JSONObject()
                for (key in headers.keys()) if (key.equals("authorization", true) || key.equals("content-type", true)) builder.header(key, headers.getString(key))
                if (method == "POST") builder.post(body.toRequestBody("application/json".toMediaType())) else builder.get()
                client(args.getString("fingerprint")).newCall(builder.build()).execute().use { response ->
                    val input = response.body?.byteStream()
                    val output = java.io.ByteArrayOutputStream()
                    val buffer = ByteArray(8192)
                    if (input != null) while (true) { val n = input.read(buffer); if (n < 0) break; require(output.size() + n <= 8 * 1024 * 1024) { "Response too large" }; output.write(buffer, 0, n) }
                    val bytes = output.toByteArray()
                    require(bytes.size <= 8 * 1024 * 1024) { "Response too large" }
                    invoke.resolve(JSObject().put("status", response.code).put("body", bytes.toString(Charsets.UTF_8)))
                }
            } catch (e: Exception) { invoke.reject(e.message ?: "Core request failed") }
        }
    }
    private fun emit(name: String, value: JSONObject) { val js = "window.__PANESTRA_NATIVE_EVENT__(${JSONObject.quote(name)},${value});"; activity.runOnUiThread { surface.evaluateJavascript(js, null) } }
    @Command fun connect(invoke: Invoke) {
        try {
            val args = invoke.getArgs()
            val id = args.getString("connectionId")
            val request = Request.Builder().url(endpoint(args.getString("endpoint"), "/ws/v1").replaceFirst("https:", "wss:")).build()
            val socket = client(args.getString("fingerprint")).newWebSocket(request, object : WebSocketListener() {
                override fun onOpen(ws: WebSocket, response: Response) {
                    ws.send(JSONObject().put("type", "auth").put("token", args.getString("token")).put("lastServerSeq", args.optLong("lastServerSeq", 0)).toString())
                    ws.send(JSONObject().put("type", "subscribe").put("topics", args.getJSONArray("topics")).toString())
                }
                override fun onMessage(ws: WebSocket, text: String) { if (text.length > 8 * 1024 * 1024) { ws.cancel(); return }; emit("panestra:message", JSONObject().put("connectionId", id).put("data", text)) }
                override fun onClosing(ws: WebSocket, code: Int, reason: String) { ws.close(code, reason); sockets.remove(id); emit("panestra:closed", JSONObject().put("connectionId", id)) }
                override fun onClosed(ws: WebSocket, code: Int, reason: String) { sockets.remove(id); emit("panestra:closed", JSONObject().put("connectionId", id)) }
                override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) { sockets.remove(id); emit("panestra:closed", JSONObject().put("connectionId", id)) }
            })
            sockets[id] = socket
            invoke.resolve()
        } catch (e: Exception) { invoke.reject(e.message ?: "WebSocket failed") }
    }
    @Command fun disconnect(invoke: Invoke) { sockets.remove(invoke.getArgs().getString("connectionId"))?.close(1000, "Surface disconnected"); invoke.resolve() }
}
