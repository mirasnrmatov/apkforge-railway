package com.apkforge.webview

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.view.KeyEvent
import android.webkit.CookieManager
import android.webkit.MimeTypeMap
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebChromeClient.FileChooserParams
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.ProgressBar
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import java.io.File

/**
 * Барлық веб-код assets/www/ ішінде тұрады.
 * Қосымша ашылғанда WebView file:///android_asset/www/index.html-ды жүктейді.
 */
class MainActivity : ComponentActivity() {

    private lateinit var webView: WebView
    private lateinit var progress: ProgressBar

    private class PendingDownload(
        val url: String,
        val userAgent: String?,
        val contentDisposition: String?,
        val mimeType: String?,
    )

    // Android 6–9: жад рұқсаты сұралып жатқанда күтіп тұрған жүктеу
    private var pendingDownload: PendingDownload? = null

    private val storagePermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            val download = pendingDownload ?: return@registerForActivityResult
            pendingDownload = null
            if (granted) {
                startDownload(download)
            } else {
                Toast.makeText(this, "Жүктеу үшін жад рұқсаты керек", Toast.LENGTH_LONG).show()
            }
        }

    // <input type="file">: WebView файл күтіп тұрған callback және камера түсіретін файл
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var cameraFile: File? = null
    private var cameraUri: Uri? = null

    private val fileChooser =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val uris = if (result.resultCode == Activity.RESULT_OK) pickedUris(result.data) else null
            // Бас тартса да callback-ке жауап беру керек, әйтпесе келесі басулар істемейді
            fileCallback?.onReceiveValue(uris)
            fileCallback = null
            cameraFile?.let { if (uris?.contains(cameraUri) != true) it.delete() }
            cameraFile = null
            cameraUri = null
        }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webview)
        progress = findViewById(R.id.progress)

        webView.settings.apply {
            javaScriptEnabled = true            // JS қосылған
            domStorageEnabled = true            // localStorage / sessionStorage
            databaseEnabled = true
            allowFileAccess = true              // assets ішіндегі файлдарға қол жеткізу
            allowContentAccess = true
            cacheMode = WebSettings.LOAD_DEFAULT
            useWideViewPort = true              // viewport meta тегін ескеру
            loadWithOverviewMode = true
            javaScriptCanOpenWindowsAutomatically = true
            mediaPlaybackRequiresUserGesture = false
            textZoom = 100                      // жүйелік шрифт масштабын елемеу
        }

        // Сілтемелер қосымша ішінде ашылады (сыртқы браузерге кетпейді)
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView?, request: WebResourceRequest?
            ): Boolean = false

            override fun onPageFinished(view: WebView?, url: String?) {
                progress.visibility = ProgressBar.GONE
            }

            override fun onReceivedError(
                view: WebView?, request: WebResourceRequest?, error: WebResourceError?
            ) {
                progress.visibility = ProgressBar.GONE
            }
        }

        // Жүктелу прогресі
        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                progress.progress = newProgress
                progress.visibility =
                    if (newProgress < 100) ProgressBar.VISIBLE else ProgressBar.GONE
            }

            // <input type="file"> басылғанда — файл таңдау (және камера) терезесі
            override fun onShowFileChooser(
                view: WebView?,
                callback: ValueCallback<Array<Uri>>?,
                params: FileChooserParams?,
            ): Boolean {
                if (callback == null || params == null) return false
                fileCallback?.onReceiveValue(null)      // алдыңғы аяқталмаған сұрау
                fileCallback = callback
                return openFileChooser(params)
            }
        }

        // Жүктеу сілтемелері — Android DownloadManager арқылы Download папкасына
        webView.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            val download = PendingDownload(url, userAgent, contentDisposition, mimeType)
            if (needsStoragePermission()) {
                pendingDownload = download
                storagePermission.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE)
            } else {
                startDownload(download)
            }
        }

        if (savedInstanceState == null) {
            webView.loadUrl("file:///android_asset/www/index.html")
        } else {
            webView.restoreState(savedInstanceState)
        }
    }

    // Android 10+ (API 29) Download папкасына рұқсатсыз жазады; 6–9 нұсқаларында рұқсат runtime-да сұралады
    private fun needsStoragePermission(): Boolean =
        Build.VERSION.SDK_INT in Build.VERSION_CODES.M..Build.VERSION_CODES.P &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE) !=
            PackageManager.PERMISSION_GRANTED

    private fun startDownload(download: PendingDownload) {
        val uri = Uri.parse(download.url)
        // DownloadManager тек http/https жүктей алады (blob: және data: сілтемелері емес)
        if (uri.scheme != "http" && uri.scheme != "https") {
            Toast.makeText(this, "Бұл сілтемені жүктеу мүмкін емес", Toast.LENGTH_LONG).show()
            return
        }

        val fileName = URLUtil.guessFileName(download.url, download.contentDisposition, download.mimeType)
        try {
            val request = DownloadManager.Request(uri).apply {
                setTitle(fileName)
                if (!download.mimeType.isNullOrBlank()) setMimeType(download.mimeType)
                // Сайттағы сессия (cookie) мен User-Agent сақталсын
                CookieManager.getInstance().getCookie(download.url)?.let { addRequestHeader("Cookie", it) }
                download.userAgent?.let { addRequestHeader("User-Agent", it) }
                setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName)
            }
            val manager = getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
            manager.enqueue(request)
            Toast.makeText(this, "Жүктеу басталды: $fileName", Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            Toast.makeText(this, "Жүктеу сәтсіз: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }

    private fun openFileChooser(params: FileChooserParams): Boolean {
        val mimeTypes = acceptedMimeTypes(params)
        val picker = Intent(Intent.ACTION_GET_CONTENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = mimeTypes.singleOrNull() ?: "*/*"
            if (mimeTypes.size > 1) putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes)
            if (params.mode == FileChooserParams.MODE_OPEN_MULTIPLE) {
                putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            }
        }

        // Сурет қабылданса — камераны да ұсынамыз; capture атрибуты болса, бірден камера ашылады
        val acceptsImages = mimeTypes.isEmpty() || mimeTypes.any { it.startsWith("image/") }
        val camera = if (acceptsImages) createCameraIntent() else null
        val candidates = buildList {
            if (camera != null && params.isCaptureEnabled) add(camera)
            add(
                Intent.createChooser(picker, null).apply {
                    if (camera != null) putExtra(Intent.EXTRA_INITIAL_INTENTS, arrayOf(camera))
                }
            )
        }
        for (intent in candidates) {
            try {
                fileChooser.launch(intent)
                return true
            } catch (e: ActivityNotFoundException) {
                // келесі нұсқаны байқап көреміз (мыс. камера қосымшасы жоқ)
            }
        }
        fileCallback = null
        cameraFile?.delete()
        cameraFile = null
        cameraUri = null
        Toast.makeText(this, "Файл таңдайтын қосымша табылмады", Toast.LENGTH_LONG).show()
        return false
    }

    // accept="image/*,.pdf" → ["image/*", "application/pdf"]; бос тізім — кез келген файл
    private fun acceptedMimeTypes(params: FileChooserParams): Array<String> {
        val types = params.acceptTypes.orEmpty()
            .flatMap { it.split(',') }
            .map { it.trim().lowercase() }
            .filter { it.isNotEmpty() }
        val mimeTypes = types.map { type ->
            when {
                type.startsWith(".") ->
                    MimeTypeMap.getSingleton().getMimeTypeFromExtension(type.drop(1))
                        // белгісіз кеңейтім — шектемейміз, әйтпесе файлды мүлдем таңдай алмайды
                        ?: return emptyArray()
                "/" in type -> type
                else -> return emptyArray()
            }
        }.distinct()
        return if ("*/*" in mimeTypes) emptyArray() else mimeTypes.toTypedArray()
    }

    // Камера суретті cache/camera/ ішіне сақтайды; WebView оны FileProvider URI арқылы оқиды
    private fun createCameraIntent(): Intent? {
        val dir = File(cacheDir, "camera").apply { mkdirs() }
        // ескі (бір тәуліктен асқан) суреттерді тазалау
        dir.listFiles()?.filter { System.currentTimeMillis() - it.lastModified() > 24 * 60 * 60 * 1000 }
            ?.forEach { it.delete() }

        val file = File(dir, "photo_${System.currentTimeMillis()}.jpg")
        val uri = try {
            FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
        } catch (e: IllegalArgumentException) {
            return null
        }
        val flags = Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION
        val intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE).apply {
            putExtra(MediaStore.EXTRA_OUTPUT, uri)
            clipData = ClipData.newRawUri("", uri)
            addFlags(flags)
        }
        // Chooser арқылы ашылғанда да камера қосымшасы файлға жаза алсын
        @Suppress("DEPRECATION")
        packageManager.queryIntentActivities(intent, PackageManager.MATCH_DEFAULT_ONLY).forEach {
            grantUriPermission(it.activityInfo.packageName, uri, flags)
        }
        cameraFile = file
        cameraUri = uri
        return intent
    }

    // Таңдалған файлдар: бірнеше (ClipData), біреу (data) немесе камера суреті
    private fun pickedUris(data: Intent?): Array<Uri>? {
        val clip = data?.clipData
        val uris = when {
            clip != null && clip.itemCount > 0 && clip.getItemAt(0).uri != cameraUri ->
                Array(clip.itemCount) { clip.getItemAt(it).uri }
            data?.data != null -> arrayOf(data.data!!)
            cameraFile?.let { it.exists() && it.length() > 0 } == true -> arrayOf(cameraUri!!)
            else -> null
        }
        return uris?.filterNotNull()?.toTypedArray()?.takeIf { it.isNotEmpty() }
    }

    // Артқа батырма — веб-беттер тарихы бойынша жүреді
    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView.canGoBack()) {
            webView.goBack()
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }
}
