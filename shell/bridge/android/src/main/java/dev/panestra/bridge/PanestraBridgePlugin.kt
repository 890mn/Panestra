package dev.panestra.bridge

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
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
    private val updating = java.util.concurrent.atomic.AtomicBoolean(false)
    private var pendingUpdate: java.io.File? = null
    private val updateClient = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS).callTimeout(10, TimeUnit.MINUTES).build()

    @Command fun installAppUpdate(invoke: Invoke) {
        if (!updating.compareAndSet(false, true)) { invoke.reject("更新已在进行中"); return }
        executor.execute {
            var downloaded: java.io.File? = null
            try {
                val expected = invoke.getArgs().getString("expectedVersion")
                require(expected.matches(Regex("[0-9]+\\.[0-9]+\\.[0-9]+"))) { "更新版本格式不正确" }
                @Suppress("DEPRECATION")
                val currentVersion = activity.packageManager.getPackageInfo(activity.packageName, 0).versionName ?: "0.0.0"
                require(UpdatePolicy.isNewer(expected, currentVersion)) { "当前没有可安装的更新" }
                val request = Request.Builder().url("https://api.github.com/repos/890mn/Panestra/releases/latest")
                    .header("Accept", "application/vnd.github+json").header("User-Agent", "Panestra-Android").build()
                val release = updateClient.newCall(request).execute().use { response ->
                    require(response.isSuccessful) { "无法读取发布信息，请重新检查更新" }
                    val source = response.body?.source() ?: error("发布信息为空")
                    require(!source.request(2L * 1024 * 1024 + 1)) { "发布信息过大" }
                    JSONObject(source.readUtf8())
                }
                require(!release.optBoolean("prerelease") && !release.optBoolean("draft") &&
                    release.getString("tag_name").removePrefix("v") == expected) { "发布版本已变化，请重新检查更新" }
                val assets = release.getJSONArray("assets")
                val asset = (0 until assets.length()).map { assets.getJSONObject(it) }
                    .firstOrNull { it.getString("name") == "Panestra-$expected-android-arm64.apk" }
                    ?: error("此平台的更新包尚未发布")
                val uri = Uri.parse(asset.getString("browser_download_url"))
                require(uri.scheme == "https" && uri.encodedAuthority == "github.com" &&
                    uri.path?.startsWith("/890mn/Panestra/releases/download/") == true) { "更新地址不可信" }
                val digest = asset.optString("digest")
                require(digest.matches(Regex("sha256:[a-f0-9]{64}"))) { "此更新包未提供完整性校验" }
                val size = asset.getLong("size")
                require(size in 1..268435456L) { "更新包大小不正确" }
                val directory = java.io.File(activity.cacheDir, "updates").apply { mkdirs() }
                downloaded = java.io.File(directory, "pending.apk")
                val hash = MessageDigest.getInstance("SHA-256")
                var received = 0L
                var lastPercent = -1
                updateClient.newCall(Request.Builder().url(uri.toString()).build()).execute().use { response ->
                    require(response.isSuccessful && response.request.url.isHttps) { "更新下载失败" }
                    val input = response.body?.byteStream() ?: error("更新包为空")
                    downloaded!!.outputStream().use { output ->
                        val buffer = ByteArray(32768)
                        while (true) {
                            val count = input.read(buffer); if (count < 0) break
                            received += count; require(received <= size) { "更新包大小不正确" }
                            output.write(buffer, 0, count); hash.update(buffer, 0, count)
                            val percent = (received * 100 / size).toInt()
                            if (percent != lastPercent) { lastPercent = percent; emit("panestra:update-progress", JSONObject().put("percent", percent)) }
                        }
                    }
                }
                val actual = hash.digest().joinToString("") { "%02x".format(it.toInt() and 255) }
                UpdatePolicy.validateIntegrity(size, received, digest, actual)
                verifyUpdate(downloaded!!, expected)
                pendingUpdate = downloaded
                activity.runOnUiThread {
                    try {
                        if (!activity.packageManager.canRequestPackageInstalls()) {
                            startActivityForResult(invoke, Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                Uri.parse("package:" + activity.packageName)), "updatePermissionResult")
                        } else openUpdateInstaller(invoke)
                    } catch (_: Exception) { downloaded?.delete(); updating.set(false); invoke.reject("无法打开系统安装窗口") }
                }
            } catch (e: Exception) { downloaded?.delete(); updating.set(false); invoke.reject(e.message ?: "更新下载失败，请稍后重试") }
        }
    }

    @Suppress("DEPRECATION")
    private fun verifyUpdate(file: java.io.File, version: String) {
        val manager = activity.packageManager
        val flags = android.content.pm.PackageManager.GET_SIGNING_CERTIFICATES
        val installed = manager.getPackageInfo(activity.packageName, flags)
        val candidate = manager.getPackageArchiveInfo(file.absolutePath, flags) ?: error("更新包无法读取")
        val current = installed.signingInfo?.apkContentsSigners?.map { it.toCharsString() }?.toSet()
        val next = candidate.signingInfo?.apkContentsSigners?.map { it.toCharsString() }?.toSet()
        UpdatePolicy.validateIdentity(activity.packageName, candidate.packageName, version, candidate.versionName,
            installed.longVersionCode, candidate.longVersionCode, current, next)
    }

    @ActivityCallback fun updatePermissionResult(invoke: Invoke, result: ActivityResult) {
        if (!activity.packageManager.canRequestPackageInstalls()) {
            pendingUpdate?.delete(); pendingUpdate = null; updating.set(false)
            invoke.reject("未允许安装更新，可稍后再次点击下载并更新"); return
        }
        try { openUpdateInstaller(invoke) }
        catch (_: Exception) { pendingUpdate?.delete(); pendingUpdate = null; updating.set(false); invoke.reject("无法打开系统安装窗口") }
    }

    private fun openUpdateInstaller(invoke: Invoke) {
        val file = pendingUpdate ?: error("请重新下载更新")
        val uri = androidx.core.content.FileProvider.getUriForFile(activity, activity.packageName + ".updates", file)
        activity.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
        updating.set(false)
        invoke.resolve(JSObject())
    }
    @Command fun openGithub(invoke: Invoke) {
        activity.runOnUiThread {
            try {
                activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://github.com/890mn/Panestra")))
                invoke.resolve(JSObject())
            } catch (e: Exception) { invoke.reject("无法打开浏览器，请访问 github.com/890mn/Panestra") }
        }
    }
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
    private fun connectionError(error: Throwable): String {
        val messages = mutableListOf<String>()
        var cause: Throwable? = error
        repeat(8) {
            val current = cause ?: return@repeat
            val message = current.message ?: current.javaClass.simpleName
            if (messages.lastOrNull() != message) messages.add(message)
            cause = current.cause
        }
        return messages.joinToString(": ")
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
            } catch (e: Exception) { invoke.reject(connectionError(e)) }
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
