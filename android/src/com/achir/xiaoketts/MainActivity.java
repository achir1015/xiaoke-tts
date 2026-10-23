package com.achir.xiaoketts;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * 小柯機器人台灣語音 MP3 工具 — Android 版
 * 用 WebView 開啟和線上版同一份網頁（放在 APK 的 assets/web）。打開就能用：語音引擎由網頁自動連線；
 * 離開 App（finish）時 WebView 一併銷毀，產生中的工作、播放、錄音全部停止。
 * 網頁從 https://appassets.androidplatform.net/ 載入（安全來源：ES 模組、IndexedDB、麥克風才能用），
 * 由 shouldInterceptRequest 直接回傳 assets 裡的檔案。
 */
public class MainActivity extends Activity {
    static final String TAG = "XiaokeTTS";
    static final String ORIGIN = "https://appassets.androidplatform.net";
    static final int REQ_FILES = 1;
    static final int REQ_MIC = 2;

    WebView web;
    Bridge bridge;
    ValueCallback<Uri[]> fileCallback;
    PermissionRequest pendingMic;
    String[] pendingRes;
    long lastBack = 0;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED);
        web = new WebView(this);
        web.setBackgroundColor(0xFFF4F6F5);
        setContentView(web);
        WebView.setWebContentsDebuggingEnabled(BuildFlags.DEBUG);   // python build.py debug 才開（給 chrome://inspect 測試用）

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportZoom(false);
        s.setTextZoom(100);   // 不跟著系統字型大小放大，版面才不會擠在一起
        s.setUserAgentString(s.getUserAgentString() + " XiaokeTTSAndroid/" + Bridge.version(this));

        bridge = new Bridge(this);
        web.addJavascriptInterface(bridge, "XiaokeAndroid");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (!ORIGIN.equals(u.getScheme() + "://" + u.getHost())) return null;
                return serve(u.getPath());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (ORIGIN.equals(u.getScheme() + "://" + u.getHost())) return false;
                // 外部連結（申請權杖、GitHub）交給系統瀏覽器
                try { startActivity(new Intent(Intent.ACTION_VIEW, u).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); } catch (Exception ignored) { }
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
                i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, p.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                String[] types = p.getAcceptTypes();
                if (types != null) {
                    java.util.List<String> mimes = new java.util.ArrayList<>();
                    boolean onlyMime = true;
                    for (String t : types) for (String x : t.split(",")) {
                        x = x.trim();
                        if (x.contains("/")) mimes.add(x); else if (x.startsWith(".")) onlyMime = false;
                    }
                    if (onlyMime && !mimes.isEmpty()) i.putExtra(Intent.EXTRA_MIME_TYPES, mimes.toArray(new String[0]));
                }
                try { startActivityForResult(i, REQ_FILES); }
                catch (Exception e) { fileCallback = null; return false; }
                return true;
            }

            /** 網頁要用麥克風（錄聲音範本）或相機（掃描權杖 QR Code）：先問 Android 的權限，再允許網頁使用 */
            @Override
            public void onPermissionRequest(final PermissionRequest r) {
                java.util.List<String> res = new java.util.ArrayList<>(), need = new java.util.ArrayList<>();
                for (String x : r.getResources()) {
                    String p = PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(x) ? Manifest.permission.RECORD_AUDIO
                            : PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(x) ? Manifest.permission.CAMERA : null;
                    if (p == null) continue;
                    res.add(x);
                    if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) need.add(p);
                }
                if (res.isEmpty()) { r.deny(); return; }
                if (need.isEmpty()) { r.grant(res.toArray(new String[0])); return; }
                pendingMic = r;
                pendingRes = res.toArray(new String[0]);
                requestPermissions(need.toArray(new String[0]), REQ_MIC);
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                Log.d(TAG, m.message() + " @" + m.sourceId() + ":" + m.lineNumber());
                return true;
            }
        });

        web.loadUrl(ORIGIN + "/index.html");
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] perms, int[] res) {
        if (req == REQ_MIC && pendingMic != null) {
            boolean all = res.length > 0;
            for (int g : res) if (g != PackageManager.PERMISSION_GRANTED) all = false;
            if (all) pendingMic.grant(pendingRes);
            else { pendingMic.deny(); Toast.makeText(this, "沒有取得權限：可以到手機的「設定 → 應用程式 → 小柯語音 → 權限」打開", Toast.LENGTH_LONG).show(); }
            pendingMic = null;
        }
    }

    /** 回傳 assets/web 裡的檔案 */
    WebResourceResponse serve(String path) {
        try {
            if (path == null || path.equals("/")) path = "/index.html";
            Map<String, String> h = new HashMap<>();
            h.put("Cache-Control", "no-store");
            h.put("Access-Control-Allow-Origin", ORIGIN);
            InputStream in = getAssets().open("web" + Uri.decode(path));
            String m = mime(path);
            return new WebResourceResponse(m, m.startsWith("text") || m.endsWith("json") ? "utf-8" : null, 200, "OK", h, in);
        } catch (Exception e) {
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", null, null);
        }
    }

    static String mime(String p) {
        p = p.toLowerCase();
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".webmanifest")) return "application/manifest+json";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".ico")) return "image/x-icon";
        if (p.endsWith(".mp3")) return "audio/mpeg";
        return "application/octet-stream";
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req == REQ_FILES && fileCallback != null) {
            Uri[] out = null;
            if (res == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int n = data.getClipData().getItemCount();
                    out = new Uri[n];
                    for (int k = 0; k < n; k++) out[k] = data.getClipData().getItemAt(k).getUri();
                } else if (data.getData() != null) out = new Uri[]{data.getData()};
            }
            fileCallback.onReceiveValue(out);
            fileCallback = null;
            return;
        }
        super.onActivityResult(req, res, data);
    }

    @Override
    public void onBackPressed() {
        // 先關掉錄音對話框；不在「單一語音」就先回到單一語音；都沒有再按一次才離開
        web.evaluateJavascript("(function(){var d=document.querySelector('#recDlg:not(.hide)');if(d){document.querySelector('#recCancel').click();return true}"
                + "var t=document.querySelector('#tabs .on');if(t&&t.dataset.tab!=='tts'){document.querySelector('[data-tab=tts]').click();return true}return false})()", v -> {
            if ("true".equals(v)) return;
            long now = System.currentTimeMillis();
            if (now - lastBack < 2000) { finish(); return; }
            lastBack = now;
            Toast.makeText(this, "再按一次返回鍵離開", Toast.LENGTH_SHORT).show();
        });
    }

    @Override
    protected void onPause() { super.onPause(); web.onPause(); }

    @Override
    protected void onResume() { super.onResume(); web.onResume(); }

    @Override
    protected void onDestroy() {
        // 離開 App：銷毀 WebView，所有工作（產生語音、播放、錄音）一起停止
        web.removeJavascriptInterface("XiaokeAndroid");
        web.loadUrl("about:blank");
        web.destroy();
        super.onDestroy();
    }
}
