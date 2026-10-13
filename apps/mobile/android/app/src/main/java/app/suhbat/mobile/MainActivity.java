package app.suhbat.mobile;

import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import android.webkit.JavascriptInterface;

import androidx.activity.OnBackPressedCallback;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getBridge().getWebView().addJavascriptInterface(new NativeBridge(), "SuhbatNative");
        Updater.restore(this);
        // Back: close the topmost thing inside the app (menu, dialog, settings page, chat); at the very top just go to the
        // background, like Telegram, instead of destroying the activity.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                getBridge().getWebView().evaluateJavascript(
                        "(function(){try{return !!(window.__nativeBack&&window.__nativeBack())}catch(e){return false}})()",
                        value -> {
                            if (!"true".equals(value)) moveTaskToBack(true);
                        });
            }
        });
        askNotificationPermission();
        startBackground();
        showOverLockScreen(getIntent());
        getBridge().getWebView().setWebViewClient(new BridgeWebViewClient(getBridge()) {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (openExternally(request.getUrl())) return true;
                return super.shouldOverrideUrlLoading(view, request);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                if (openExternally(Uri.parse(url))) return true;
                return super.shouldOverrideUrlLoading(view, url);
            }

            /** Android may kill the web renderer while the app waits in the background (e.g. in Telegram): start over, not a white screen. */
            @Override
            public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
                runOnUiThread(() -> recreate());
                return true;
            }
        });
    }

    /** Back from another app: if the page is empty or stranded on a foreign site, load the messenger again. */
    private void checkPageHealth() {
        try {
            final WebView wv = getBridge().getWebView();
            String saved = getSharedPreferences(PushService.PREFS, MODE_PRIVATE).getString(PushService.KEY_ORIGIN, null);
            final String origin = saved != null ? saved : "https://suhbat-dosh.uz";
            wv.evaluateJavascript(
                    "(function(){return (location.origin||'')+'|'+((document.body&&document.body.children.length)||0)})()",
                    v -> {
                        String s = v == null ? "" : v.replace("\"", "");
                        String[] p = s.split("\\|");
                        boolean local = p.length > 0 && (p[0].equals("https://localhost") || p[0].equals("http://localhost"));
                        boolean sameOrigin = p.length > 0 && (local || p[0].equals(origin));
                        boolean empty = p.length < 2 || "0".equals(p[1]);
                        if (!sameOrigin || empty) wv.loadUrl(origin);
                    });
        } catch (Exception ignored) { /* bridge not ready yet */ }
    }

    /** An incoming-call notification opens the app on top of the lock screen and wakes the display. */
    private void showOverLockScreen(Intent intent) {
        if (intent == null || !intent.getBooleanExtra("incoming_call", false)) return;
        try {
            if (Build.VERSION.SDK_INT >= 27) {
                setShowWhenLocked(true);
                setTurnScreenOn(true);
            } else {
                getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | android.view.WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
            }
            intent.removeExtra("incoming_call");
        } catch (Exception ignored) { /* best effort */ }
    }

    /** Once: ask Android not to put the app to sleep (otherwise the phone may delay messages in Doze). */
    private void askBatteryExemptionOnce() {
        try {
            android.content.SharedPreferences p = getSharedPreferences(PushService.PREFS, MODE_PRIVATE);
            if (p.getBoolean("battery_asked", false)) return;
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm == null || pm.isIgnoringBatteryOptimizations(getPackageName())) return;
            p.edit().putBoolean("battery_asked", true).apply();
            Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName()));
            startActivity(i);
        } catch (Exception ignored) { /* the settings row still offers it */ }
    }

    private void startBackground() {
        String o = getSharedPreferences(PushService.PREFS, MODE_PRIVATE).getString(PushService.KEY_ORIGIN, null);
        if (o == null) return;
        try {
            ContextCompat.startForegroundService(this, new Intent(this, PushService.class));
        } catch (Exception ignored) { /* retried on the next start */ }
    }

    private void askNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33
                && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, new String[]{Manifest.permission.POST_NOTIFICATIONS}, 71);
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        checkPageHealth();
        PushService.appVisible = true;
        android.app.NotificationManager nm = (android.app.NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        nm.cancel(PushService.ID_CALL);
        openChatFromIntent(getIntent());
    }

    @Override
    public void onPause() {
        // keep the sign-in cookie on disk: the app may be killed in the background
        try { android.webkit.CookieManager.getInstance().flush(); } catch (Exception ignored) { /* best effort */ }
        PushService.appVisible = false;
        super.onPause();
        Updater.installIfReady(getApplicationContext());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        showOverLockScreen(intent);
    }

    private void openChatFromIntent(Intent intent) {
        if (intent == null) return;
        if (intent.getBooleanExtra("install_update", false)) {
            intent.removeExtra("install_update");
            Updater.installSession(this, true);
        }
        int id = intent.getIntExtra("chat_id", 0);
        if (id <= 0) return;
        intent.removeExtra("chat_id");
        final String js = "window.__openChat&&window.__openChat(" + id + ")";
        getBridge().getWebView().postDelayed(() -> getBridge().getWebView().evaluateJavascript(js, null), 600);
    }

    /** Methods the web client may call (it runs from the user's own server). */
    public class NativeBridge {
        @JavascriptInterface
        public void configure(String origin) {
            if (origin == null || !(origin.startsWith("https://") || origin.startsWith("http://"))) return;
            getSharedPreferences(PushService.PREFS, MODE_PRIVATE).edit().putString(PushService.KEY_ORIGIN, origin).apply();
            runOnUiThread(() -> { startBackground(); askBatteryExemptionOnce(); });
        }

        @JavascriptInterface
        public boolean isBatteryUnrestricted() {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            return pm == null || pm.isIgnoringBatteryOptimizations(getPackageName());
        }

        @JavascriptInterface
        public void openBatterySettings() {
            runOnUiThread(() -> {
                try {
                    Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName()));
                    startActivity(i);
                } catch (Exception e) {
                    try { startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)); } catch (Exception ignored) { /* none */ }
                }
            });
        }

        /** Links, phone numbers and e-mail addresses open in the matching app (browser, dialer, mail). */
        @JavascriptInterface
        public void openUrl(String url) {
            if (url == null || !url.matches("(?i)^(https?://|tel:|mailto:|geo:).*")) return;
            runOnUiThread(() -> {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                } catch (Exception e) {
                    android.widget.Toast.makeText(MainActivity.this, "Не удалось открыть: " + url, android.widget.Toast.LENGTH_SHORT).show();
                }
            });
        }

        private final java.util.concurrent.ExecutorService prefetchQueue = java.util.concurrent.Executors.newSingleThreadExecutor();

        private String sha1(String v) {
            try {
                byte[] d = java.security.MessageDigest.getInstance("SHA-1").digest(v.getBytes("UTF-8"));
                StringBuilder sb = new StringBuilder();
                for (byte x : d) sb.append(String.format("%02x", x));
                return sb.toString();
            } catch (Exception e) { return Integer.toHexString(v.hashCode()); }
        }

        /** A file id never changes its content, so one download is reused: the second tap (or a prefetch) opens at once. */
        private java.io.File cacheTarget(String url, String name) {
            String clean = url.contains("?") ? url.substring(0, url.indexOf('?')) : url;
            java.io.File dir = new java.io.File(new java.io.File(getCacheDir(), "files"), sha1(clean));
            String safe = (name == null || name.isEmpty() ? "file" : name).replaceAll("[\\\\/:*?\"<>|]", "_");
            return new java.io.File(dir, safe);
        }

        private java.io.File download(String origin, String url, String name) throws java.io.IOException {
            java.io.File f = cacheTarget(url, name);
            if (f.isFile() && f.length() > 0) return f;
            synchronized (this) {
                if (f.isFile() && f.length() > 0) return f;
                f.getParentFile().mkdirs();
                String cookie = android.webkit.CookieManager.getInstance().getCookie(origin);
                okhttp3.Request.Builder rb = new okhttp3.Request.Builder().url(url);
                if (cookie != null) rb.header("Cookie", cookie);
                java.io.File part = new java.io.File(f.getPath() + ".part");
                try (okhttp3.Response r = new okhttp3.OkHttpClient().newCall(rb.build()).execute()) {
                    if (!r.isSuccessful() || r.body() == null) throw new java.io.IOException("HTTP " + r.code());
                    try (java.io.InputStream in = r.body().byteStream(); java.io.FileOutputStream out = new java.io.FileOutputStream(part)) {
                        byte[] buf = new byte[65536];
                        int n;
                        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                    }
                }
                if (!part.renameTo(f)) throw new java.io.IOException("rename");
                trimCache();
                return f;
            }
        }

        /** Keep the opened-files cache below ~400 MB (oldest folders go first). */
        private void trimCache() {
            try {
                java.io.File root = new java.io.File(getCacheDir(), "files");
                java.io.File[] dirs = root.listFiles();
                if (dirs == null) return;
                long total = 0;
                for (java.io.File d : dirs) { java.io.File[] fs = d.listFiles(); if (fs != null) for (java.io.File x : fs) total += x.length(); }
                if (total < 400L * 1024 * 1024) return;
                java.util.Arrays.sort(dirs, (p, q) -> Long.compare(p.lastModified(), q.lastModified()));
                for (java.io.File d : dirs) {
                    java.io.File[] fs = d.listFiles();
                    if (fs != null) for (java.io.File x : fs) { total -= x.length(); x.delete(); }
                    d.delete();
                    if (total < 300L * 1024 * 1024) break;
                }
            } catch (Exception ignored) { /* best effort */ }
        }

        private boolean ownUrl(String url) {
            String origin = getSharedPreferences(PushService.PREFS, MODE_PRIVATE).getString(PushService.KEY_ORIGIN, null);
            return url != null && origin != null && url.startsWith(origin + "/");
        }

        private String originPref() {
            return getSharedPreferences(PushService.PREFS, MODE_PRIVATE).getString(PushService.KEY_ORIGIN, null);
        }

        /** Quietly fetch a received document in the background so that opening it later is instant. */
        @JavascriptInterface
        public void prefetchFile(String url, String name) {
            if (!ownUrl(url)) return;
            final String origin = originPref();
            prefetchQueue.execute(() -> {
                try { download(origin, url, name); } catch (Exception ignored) { /* it will be fetched on tap */ }
            });
        }

        /** Open a received file in the matching app (Word, Excel, PDF ...). Already downloaded: at once. */
        @JavascriptInterface
        public void openFile(String url, String name, String mime) {
            if (!ownUrl(url)) return;
            final String origin = originPref();
            final boolean ready = cacheTarget(url, name).isFile();
            if (!ready) runOnUiThread(() -> android.widget.Toast.makeText(MainActivity.this, "Загружаю файл…", android.widget.Toast.LENGTH_SHORT).show());
            new Thread(() -> {
                try {
                    java.io.File f = download(origin, url, name);
                    f.setLastModified(System.currentTimeMillis());
                    String ext = android.webkit.MimeTypeMap.getFileExtensionFromUrl(Uri.fromFile(f).toString());
                    String type = ext != null ? android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext.toLowerCase()) : null;
                    if (type == null) type = (mime != null && !mime.isEmpty() && !mime.equals("application/octet-stream")) ? mime : "*/*";
                    Uri uri = androidx.core.content.FileProvider.getUriForFile(MainActivity.this, getPackageName() + ".fileprovider", f);
                    Intent i = new Intent(Intent.ACTION_VIEW);
                    i.setDataAndType(uri, type);
                    i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                    runOnUiThread(() -> {
                        try { startActivity(Intent.createChooser(i, null)); } catch (ActivityNotFoundException e) {
                            android.widget.Toast.makeText(MainActivity.this, "Нет приложения для этого файла", android.widget.Toast.LENGTH_LONG).show();
                        }
                    });
                } catch (Exception e) {
                    runOnUiThread(() -> android.widget.Toast.makeText(MainActivity.this, "Не удалось открыть файл", android.widget.Toast.LENGTH_LONG).show());
                }
            }).start();
        }

        /** Background download of a newer APK; the result is read with updateState(). */
        @JavascriptInterface
        public void downloadUpdate(String url, String version) {
            final String origin = getSharedPreferences(PushService.PREFS, MODE_PRIVATE).getString(PushService.KEY_ORIGIN, null);
            if (url == null || version == null || origin == null || !url.startsWith(origin + "/downloads/")) return;
            Updater.download(getApplicationContext(), origin, url, version);
        }

        /** The real installed version (the user-agent string can be stale). */
        /** Call audio routing: on = the call is live (speaker = loudspeaker instead of the earpiece); off = back to normal. */
        @JavascriptInterface
        public void callAudio(boolean on, boolean speaker) {
            runOnUiThread(() -> {
                android.media.AudioManager am = (android.media.AudioManager) getSystemService(Context.AUDIO_SERVICE);
                if (am == null) return;
                if (on) {
                    am.setMode(android.media.AudioManager.MODE_IN_COMMUNICATION);
                    route(am, speaker);
                } else {
                    route(am, false);
                    am.setMode(android.media.AudioManager.MODE_NORMAL);
                }
            });
        }

        @JavascriptInterface
        public void setSpeaker(boolean on) {
            runOnUiThread(() -> {
                android.media.AudioManager am = (android.media.AudioManager) getSystemService(Context.AUDIO_SERVICE);
                if (am != null) route(am, on);
            });
        }

        private void route(android.media.AudioManager am, boolean speaker) {
            try {
                if (Build.VERSION.SDK_INT >= 31) {
                    if (speaker) {
                        for (android.media.AudioDeviceInfo d : am.getAvailableCommunicationDevices()) {
                            if (d.getType() == android.media.AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) { am.setCommunicationDevice(d); return; }
                        }
                    } else {
                        am.clearCommunicationDevice();
                        return;
                    }
                }
            } catch (Exception ignored) { /* fall back below */ }
            am.setSpeakerphoneOn(speaker);
        }

        @JavascriptInterface
        public String appVersion() {
            try {
                return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public String updateState() {
            return "{\"state\":\"" + Updater.state + "\",\"version\":\"" + Updater.version + "\",\"percent\":" + Updater.percent + ",\"error\":\"" + Updater.lastError.replace("\\", " ").replace("\"", "'") + "\"}";
        }

        @JavascriptInterface
        public void installUpdate() {
            runOnUiThread(() -> Updater.installSession(MainActivity.this, true));
        }

        @JavascriptInterface
        public void stopBackground() {
            getSharedPreferences(PushService.PREFS, MODE_PRIVATE).edit().remove(PushService.KEY_ORIGIN).apply();
            runOnUiThread(() -> stopService(new Intent(MainActivity.this, PushService.class)));
        }
    }

    /** tg:, mailto:, tel:, intent: ... are handed to the matching app instead of failing inside the WebView. */
    private boolean openExternally(Uri uri) {
        String s = uri.getScheme();
        if (s == null) return false;
        s = s.toLowerCase();
        if (s.equals("http") || s.equals("https") || s.equals("file") || s.equals("about")
                || s.equals("data") || s.equals("blob") || s.equals("javascript") || s.equals("ws") || s.equals("wss")
                || s.equals("capacitor")) {
            return false;
        }
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, uri);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (ActivityNotFoundException e) {
            // Telegram is not installed: open the same bot link on the web instead
            if (s.equals("tg") && "resolve".equals(uri.getHost())) {
                String domain = uri.getQueryParameter("domain");
                String start = uri.getQueryParameter("start");
                if (domain != null) {
                    String web = "https://t.me/" + Uri.encode(domain) + (start != null ? "?start=" + Uri.encode(start) : "");
                    try {
                        Intent w = new Intent(Intent.ACTION_VIEW, Uri.parse(web));
                        w.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        startActivity(w);
                    } catch (ActivityNotFoundException ignored) { /* no browser either */ }
                }
            }
        }
        return true;
    }
}
