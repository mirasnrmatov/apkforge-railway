package com.apkforge.webview

import android.Manifest
import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.view.KeyEvent
import android.webkit.CookieManager
import android.webkit.URLUtil
import android.webkit.WebChromeClient
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
