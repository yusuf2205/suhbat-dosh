package app.suhbat.mobile;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.webkit.CookieManager;
import android.widget.Toast;

import androidx.core.app.NotificationCompat;
import androidx.core.content.FileProvider;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.io.InputStream;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

/** Like Telegram: the new APK downloads by itself in the background; Android only asks for the final install tap. */
final class Updater {
    static final String CH = "updates";
    static volatile String state = "idle"; // idle | downloading | ready | error
    static volatile String version = "";
    static volatile int percent = 0;
    private static boolean running = false;
    static volatile boolean installing = false;

    private Updater() {}

    static File apk(Context c) {
        File dir = new File(c.getCacheDir(), "updates");
        dir.mkdirs();
        return new File(dir, "suhbat-update.apk");
    }

    /** On start: a finished download of a newer version is offered for install, anything else is removed. */
    static void restore(Context c) {
        SharedPreferences p = c.getSharedPreferences(PushService.PREFS, Context.MODE_PRIVATE);
        String ready = p.getString("update_ready", null);
        File f = apk(c);
        try {
            PackageInfo pi = c.getPackageManager().getPackageInfo(c.getPackageName(), 0);
            if (ready != null && f.exists() && newer(ready, pi.versionName)) {
                state = "ready"; version = ready; percent = 100;
                return;
            }
        } catch (Exception ignored) { /* fall through */ }
        if (f.exists()) f.delete();
        p.edit().remove("update_ready").apply();
        state = "idle";
    }

    static boolean newer(String a, String b) {
        String[] x = a.split("\\.");
        String[] y = b.split("\\.");
        for (int i = 0; i < 3; i++) {
            int p = i < x.length ? Integer.parseInt(x[i].replaceAll("\\D", "0")) : 0;
            int q = i < y.length ? Integer.parseInt(y[i].replaceAll("\\D", "0")) : 0;
            if (p != q) return p > q;
        }
        return false;
    }

    static synchronized void download(Context app, String origin, String url, String ver) {
        if (running || ("ready".equals(state) && ver.equals(version))) return;
        try {
            String cur = app.getPackageManager().getPackageInfo(app.getPackageName(), 0).versionName;
            if (!newer(ver, cur)) { state = "idle"; return; }
        } catch (Exception ignored) { /* unknown: continue */ }
        running = true;
        state = "downloading"; version = ver; percent = 0;
        new Thread(() -> {
            File part = new File(apk(app).getPath() + ".part");
            try {
                String cookie = CookieManager.getInstance().getCookie(origin);
                Request.Builder rb = new Request.Builder().url(url);
                if (cookie != null) rb.header("Cookie", cookie);
                try (Response r = new OkHttpClient().newCall(rb.build()).execute()) {
                    if (!r.isSuccessful() || r.body() == null) throw new java.io.IOException("HTTP " + r.code());
                    long total = r.body().contentLength();
                    try (InputStream in = r.body().byteStream(); FileOutputStream out = new FileOutputStream(part)) {
                        byte[] buf = new byte[32768];
                        long got = 0;
                        int n;
                        while ((n = in.read(buf)) > 0) {
                            out.write(buf, 0, n);
                            got += n;
                            if (total > 0) percent = (int) (got * 100 / total);
                        }
                    }
                }
                File f = apk(app);
                if (f.exists()) f.delete();
                if (!part.renameTo(f)) throw new java.io.IOException("rename");
                app.getSharedPreferences(PushService.PREFS, Context.MODE_PRIVATE).edit().putString("update_ready", ver).apply();
                state = "ready"; percent = 100;
                // in the background nobody is interrupted: install right away (Android asks only if it has to)
                if (!PushService.appVisible) installSession(app, false);
                else notifyReady(app, ver);
            } catch (Exception e) {
                state = "error";
                part.delete();
            } finally {
                running = false;
            }
        }).start();
    }

    static void notifyReady(Context c, String ver) {
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(new NotificationChannel(CH, "Обновления", NotificationManager.IMPORTANCE_DEFAULT));
        }
        Intent i = new Intent(c, MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        i.putExtra("install_update", true);
        PendingIntent pi = PendingIntent.getActivity(c, 7001, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification n = new NotificationCompat.Builder(c, CH)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("Suhbat-dosh " + ver)
                .setContentText("Обновление загружено. Нажмите, чтобы установить.")
                .setAutoCancel(true)
                .setContentIntent(pi)
                .build();
        nm.notify(7001, n);
    }

    /** Called when the app goes to the background: a finished download is installed then. */
    static void installIfReady(Context c) {
        if ("ready".equals(state) && !installing) installSession(c, false);
    }

    /** Install through a PackageInstaller session: after the first confirmation Android 12+ updates this app without asking again. */
    static volatile long installStartedAt = 0;
    static volatile int lastSession = -1;
    static volatile boolean confirmShown = false;
    static volatile String lastError = "";

    private static void say(Context c, String msg) {
        try { Toast.makeText(c.getApplicationContext(), msg, Toast.LENGTH_LONG).show(); } catch (Exception ignored) { /* no UI thread */ }
    }

    static void installSession(Context c, boolean userInitiated) {
        if (!"ready".equals(state)) {
            if (userInitiated) say(c, "Обновление ещё загружается. Подождите немного.");
            return;
        }
        // a previous attempt that never reported back must not block the next tap
        if (installing && System.currentTimeMillis() - installStartedAt < 4000) return;
        try {
            if (Build.VERSION.SDK_INT >= 26 && !c.getPackageManager().canRequestPackageInstalls()) {
                if (userInitiated && c instanceof Activity) {
                    say(c, "Разрешите установку для Suhbat-dosh и вернитесь сюда");
                    c.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + c.getPackageName())));
                } else {
                    notifyReady(c, version);
                }
                return;
            }
            PackageInstaller pi = c.getPackageManager().getPackageInstaller();
            if (lastSession >= 0) { try { pi.abandonSession(lastSession); } catch (Exception ignored) { /* already gone */ } }
            installing = true;
            confirmShown = false;
            lastError = "";
            installStartedAt = System.currentTimeMillis();
            if (userInitiated) say(c, "Запуск установки…");
            PackageInstaller.SessionParams p = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
            p.setAppPackageName(c.getPackageName());
            if (Build.VERSION.SDK_INT >= 31) p.setRequireUserAction(userInitiated
                    ? PackageInstaller.SessionParams.USER_ACTION_REQUIRED : PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
            int id = pi.createSession(p);
            lastSession = id;
            File f = apk(c);
            try (PackageInstaller.Session s = pi.openSession(id)) {
                try (InputStream in = new FileInputStream(f); OutputStream out = s.openWrite("suhbat", 0, f.length())) {
                    byte[] buf = new byte[65536];
                    int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                    s.fsync(out);
                }
                Intent i = new Intent(c, InstallReceiver.class).setAction("app.suhbat.mobile.INSTALL_RESULT");
                int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
                s.commit(PendingIntent.getBroadcast(c, id, i, flags).getIntentSender());
            }
            // if the installer never answers (some vendor builds), fall back to the classic installer screen
            if (c instanceof Activity) {
                final Activity act = (Activity) c;
                new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
                    if (installing && !confirmShown && "ready".equals(state)) {
                        installing = false;
                        install(act);
                    }
                }, userInitiated ? 6000 : 20000);
            }
        } catch (Exception e) {
            installing = false;
            lastError = String.valueOf(e.getMessage());
            if (c instanceof Activity) install((Activity) c);
        }
    }

    /** Fallback: opens the system installer for the downloaded APK (asks once for "install unknown apps"). */
    static void install(Activity a) {
        if (!"ready".equals(state)) return;
        try {
            if (Build.VERSION.SDK_INT >= 26 && !a.getPackageManager().canRequestPackageInstalls()) {
                Toast.makeText(a, "Разрешите установку для Suhbat-dosh и вернитесь сюда", Toast.LENGTH_LONG).show();
                a.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + a.getPackageName())));
                return;
            }
            Uri uri = FileProvider.getUriForFile(a, a.getPackageName() + ".fileprovider", apk(a));
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(uri, "application/vnd.android.package-archive");
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            a.startActivity(i);
        } catch (Exception e) {
            lastError = String.valueOf(e.getMessage());
            Toast.makeText(a, "Не удалось начать установку: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }
}
