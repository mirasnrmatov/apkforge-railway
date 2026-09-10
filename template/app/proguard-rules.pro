# WebView JS интерфейсі қолданылса, оны сақтау керек.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
