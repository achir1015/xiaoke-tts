package com.achir.xiaoketts;

import android.app.DownloadManager;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.BroadcastReceiver;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.provider.Settings;
import android.util.Base64;
import android.webkit.JavascriptInterface;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/**
 * 網頁呼叫的 Android 功能（window.XiaokeAndroid）：
 * 存檔到手機（MP3 →「音樂/小柯語音」）、檢查更新與安裝新版、用瀏覽器開網址。
 * JavaScript 介面在背景執行緒執行，可以直接連網路；回傳值一律是 JSON 字串。
 */
final class Bridge {
    static final String REPO = "achir1015/xiaoke-tts";
    static final String FOLDER = "小柯語音";

    final MainActivity a;
    final Map<String, Save> saves = new HashMap<>();
    volatile JSONObject updateStatus = st("idle", 0);

    Bridge(MainActivity a) { this.a = a; }

    static final class Save { Uri uri; File file; OutputStream out; String shown; long size; }

    static JSONObject st(String state, int pct) {
        JSONObject o = new JSONObject();
        try { o.put("state", state); o.put("pct", pct); } catch (Exception ignored) { }
        return o;
    }
    static String ok(Object... kv) {
        JSONObject o = new JSONObject();
        try { o.put("status", "ok"); for (int i = 0; i + 1 < kv.length; i += 2) o.put((String) kv[i], kv[i + 1]); } catch (Exception ignored) { }
        return o.toString();
    }
    static String err(Exception e) {
        JSONObject o = new JSONObject();
        try { o.put("status", "error"); o.put("message", String.valueOf(e.getMessage())); } catch (Exception ignored) { }
        return o.toString();
    }

    static String version(Context c) {
        try { return c.getPackageManager().getPackageInfo(c.getPackageName(), 0).versionName; } catch (Exception e) { return "0"; }
    }

    static String displayName(Context c, Uri u) {
        try (Cursor cur = c.getContentResolver().query(u, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cur != null && cur.moveToFirst()) return cur.getString(0);
        } catch (Exception ignored) { }
        String p = u.getLastPathSegment();
        return p == null ? "file" : p;
    }

    @JavascriptInterface
    public String appInfo() { return ok("name", a.getString(R.string.app_name), "version", version(a), "platform", "android", "sdk", Build.VERSION.SDK_INT, "model", Build.MODEL); }

    // ---- 存檔 ----
    static String mimeOf(String name) {
        String n = name.toLowerCase();
        if (n.endsWith(".mp3")) return "audio/mpeg";
        if (n.endsWith(".mp4")) return "video/mp4";
        if (n.endsWith(".webm")) return "video/webm";
        if (n.endsWith(".gif")) return "image/gif";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".wav")) return "audio/wav";
        if (n.endsWith(".zip")) return "application/zip";
        if (n.endsWith(".json")) return "application/json";
        return "application/octet-stream";
    }

    @JavascriptInterface
    public String beginSave(String name) {
        try {
            name = name.replaceAll("[\\\\/:*?\"<>|]", "_").trim();
            if (name.isEmpty()) name = "xiaoke.mp3";
            String mime = mimeOf(name);
            String dir = mime.startsWith("video/") ? Environment.DIRECTORY_MOVIES : mime.startsWith("image/") ? Environment.DIRECTORY_PICTURES
                    : mime.startsWith("audio/") ? Environment.DIRECTORY_MUSIC : Environment.DIRECTORY_DOWNLOADS;
            Save s = new Save();
            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues v = new ContentValues();
                v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                v.put(MediaStore.MediaColumns.RELATIVE_PATH, dir + "/" + FOLDER);
                v.put(MediaStore.MediaColumns.IS_PENDING, 1);
                Uri col = mime.startsWith("video/") ? MediaStore.Video.Media.EXTERNAL_CONTENT_URI : mime.startsWith("image/") ? MediaStore.Images.Media.EXTERNAL_CONTENT_URI
                        : mime.startsWith("audio/") ? MediaStore.Audio.Media.EXTERNAL_CONTENT_URI : MediaStore.Downloads.EXTERNAL_CONTENT_URI;
                s.uri = a.getContentResolver().insert(col, v);
                if (s.uri == null) throw new Exception("無法建立檔案");
                s.out = a.getContentResolver().openOutputStream(s.uri);
            } else {
                File d = new File(Environment.getExternalStoragePublicDirectory(dir), FOLDER);
                d.mkdirs();
                s.file = new File(d, name);
                s.out = new FileOutputStream(s.file);
            }
            s.shown = dir + "/" + FOLDER + "/" + name;
            String token = UUID.randomUUID().toString();
            synchronized (saves) { saves.put(token, s); }
            return ok("token", token, "path", s.shown);
        } catch (Exception e) { return err(e); }
    }

    @JavascriptInterface
    public String writeChunk(String token, String b64) {
        Save s;
        synchronized (saves) { s = saves.get(token); }
        if (s == null) return err(new Exception("no session"));
        try {
            byte[] b = Base64.decode(b64, Base64.DEFAULT);
            s.out.write(b);
            s.size += b.length;
            return ok("size", s.size);
        } catch (Exception e) { return err(e); }
    }

    @JavascriptInterface
    public String endSave(String token) {
        Save s;
        synchronized (saves) { s = saves.remove(token); }
        if (s == null) return err(new Exception("no session"));
        try {
            s.out.close();
            if (s.uri != null && Build.VERSION.SDK_INT >= 29) {
                ContentValues v = new ContentValues();
                v.put(MediaStore.MediaColumns.IS_PENDING, 0);
                a.getContentResolver().update(s.uri, v, null, null);
            } else if (s.file != null) {
                a.sendBroadcast(new Intent(Intent.ACTION_MEDIA_SCANNER_SCAN_FILE, Uri.fromFile(s.file)));
            }
            return ok("path", s.shown, "size", s.size);
        } catch (Exception e) { return err(e); }
    }

    /** 讀剪貼簿（WebView 裡的網頁讀不到 Android 的剪貼簿，改由 App 讀；Android 10 以上 App 在前景才讀得到） */
    @JavascriptInterface
    public String readClipboard() {
        final String[] out = {""};
        final java.util.concurrent.CountDownLatch done = new java.util.concurrent.CountDownLatch(1);
        a.runOnUiThread(() -> {
            try {
                ClipboardManager cm = (ClipboardManager) a.getSystemService(Context.CLIPBOARD_SERVICE);
                ClipData c = cm == null ? null : cm.getPrimaryClip();
                if (c != null && c.getItemCount() > 0) {
                    CharSequence t = c.getItemAt(0).coerceToText(a);
                    if (t != null) out[0] = t.toString();
                }
            } catch (Exception ignored) { }
            done.countDown();
        });
        try { done.await(3, java.util.concurrent.TimeUnit.SECONDS); } catch (InterruptedException ignored) { }
        return ok("text", out[0]);
    }

    @JavascriptInterface
    public boolean openUrl(String url) {
        if (!(url.startsWith("https://achir1015.github.io/") || url.startsWith("https://github.com/") || url.startsWith("https://huggingface.co/"))) return false;
        try { a.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); return true; } catch (Exception e) { return false; }
    }

    // ---- 版本更新：GitHub Releases 最新版的 .apk ----
    static String get(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(10000);
        c.setReadTimeout(15000);
        c.setRequestProperty("Accept", "application/vnd.github+json");
        c.setRequestProperty("User-Agent", "XiaokeTTS-Android");
        try (InputStream in = c.getInputStream()) {
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
            return new String(bo.toByteArray(), "UTF-8");
        } finally { c.disconnect(); }
    }

    @JavascriptInterface
    public String checkUpdate() {
        try {
            JSONObject o = new JSONObject(get("https://api.github.com/repos/" + REPO + "/releases/latest"));
            String apk = "";
            JSONArray as = o.optJSONArray("assets");
            for (int i = 0; as != null && i < as.length(); i++) {
                JSONObject x = as.getJSONObject(i);
                if (x.optString("name").toLowerCase().endsWith(".apk")) apk = x.getString("browser_download_url");
            }
            return ok("current", version(a), "latest", o.optString("tag_name").replaceAll("^[vV]", ""), "url", apk, "page", o.optString("html_url"),
                    "notes", o.optString("body", "").split("## 下載安裝")[0].trim());
        } catch (Exception e) { return err(e); }
    }

    @JavascriptInterface
    public String updateStatus() { return updateStatus.toString(); }

    @JavascriptInterface
    public String installUpdate(final String url, final String ver) {
        if (!url.startsWith("https://github.com/" + REPO + "/releases/download/")) return err(new Exception("bad url"));
        // Android 8+ 要先允許本 App「安裝未知應用程式」：交給使用者在設定畫面自己開
        if (!a.getPackageManager().canRequestPackageInstalls()) {
            a.runOnUiThread(() -> {
                try { a.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + a.getPackageName()))); } catch (Exception ignored) { }
            });
            updateStatus = st("permission", 0);
            return ok();
        }
        final DownloadManager dm = (DownloadManager) a.getSystemService(Context.DOWNLOAD_SERVICE);
        String file = "XiaokeTTS-" + ver + ".apk";
        File old = new File(a.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), file);
        if (old.exists()) old.delete();
        DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url))
                .setTitle(a.getString(R.string.app_name) + " v" + ver)
                .setMimeType("application/vnd.android.package-archive")
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalFilesDir(a, Environment.DIRECTORY_DOWNLOADS, file);
        final long id = dm.enqueue(req);
        updateStatus = st("downloading", 0);
        final Context app = a.getApplicationContext();
        BroadcastReceiver done = new BroadcastReceiver() {
            public void onReceive(Context c, Intent i) {
                if (i.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1) != id) return;
                try { app.unregisterReceiver(this); } catch (Exception ignored) { }
                Uri uri = dm.getUriForDownloadedFile(id);
                if (uri == null) { updateStatus = st("error", 0); return; }
                updateStatus = st("launching", 100);
                Intent v = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                try { app.startActivity(v); } catch (Exception e) { updateStatus = st("error", 0); }
            }
        };
        IntentFilter f = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        if (Build.VERSION.SDK_INT >= 33) app.registerReceiver(done, f, Context.RECEIVER_EXPORTED);
        else app.registerReceiver(done, f);
        // 下載進度
        new Thread(() -> {
            while ("downloading".equals(updateStatus.optString("state"))) {
                try (Cursor cur = dm.query(new DownloadManager.Query().setFilterById(id))) {
                    if (cur != null && cur.moveToFirst()) {
                        long got = cur.getLong(cur.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
                        long all = cur.getLong(cur.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
                        int s = cur.getInt(cur.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                        if (s == DownloadManager.STATUS_FAILED) { updateStatus = st("error", 0); break; }
                        if (all > 0) updateStatus = st("downloading", (int) (got * 100 / all));
                    }
                } catch (Exception ignored) { }
                try { Thread.sleep(500); } catch (InterruptedException e) { break; }
            }
        }).start();
        return ok();
    }
}
