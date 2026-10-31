package app.suhbat.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

/** Keeps a direct transfer or an open room alive while the screen is off or another app is in front. */
public class NearbyService extends Service {
    private static final String CHANNEL = "nearby";
    private static final int ID = 7300;
    private static volatile boolean running = false;
    private PowerManager.WakeLock wake;
    private WifiManager.WifiLock wifi;

    /** Shows (or refreshes) the notification; percent below 0 means "no bar". */
    static void show(Context c, String title, int percent) {
        Intent i = new Intent(c, NearbyService.class).putExtra("title", title).putExtra("percent", percent);
        try {
            if (running) c.startService(i);
            else ContextCompat.startForegroundService(c, i);
        } catch (Exception ignored) { /* a start from the background may be refused: the transfer goes on while the app is open */ }
    }

    static void hide(Context c) {
        if (!running) return;
        try { c.stopService(new Intent(c, NearbyService.class)); } catch (Exception ignored) { /* already gone */ }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String title = intent == null ? null : intent.getStringExtra("title");
        int percent = intent == null ? -1 : intent.getIntExtra("percent", -1);
        Notification n = build(title == null ? "Suhbat-dosh" : title, percent);
        try {
            if (Build.VERSION.SDK_INT >= 29) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
            else startForeground(ID, n);
            running = true;
        } catch (Exception e) {
            stopSelf();
            return START_NOT_STICKY;
        }
        lock();
        return START_NOT_STICKY;
    }

    private Notification build(String title, int percent) {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Передача рядом", NotificationManager.IMPORTANCE_LOW);
            nm.createNotificationChannel(ch);
        }
        int flags = Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT : PendingIntent.FLAG_UPDATE_CURRENT;
        PendingIntent open = PendingIntent.getActivity(this, 7301, new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), flags);
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(title)
                .setContentIntent(open)
                .setOngoing(true)
                .setOnlyAlertOnce(true);
        if (percent >= 0) b.setProgress(100, percent, false).setContentText(percent + "%");
        return b.build();
    }

    private void lock() {
        try {
            if (wake == null) {
                wake = ((PowerManager) getSystemService(Context.POWER_SERVICE)).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "suhbat:nearby");
                wake.setReferenceCounted(false);
                wake.acquire(6 * 3600_000L);
            }
            if (wifi == null) {
                wifi = ((WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE)).createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "suhbat:nearby");
                wifi.setReferenceCounted(false);
                wifi.acquire();
            }
        } catch (Exception ignored) { /* the transfer may just go slower */ }
    }

    @Override
    public void onDestroy() {
        running = false;
        try { if (wake != null && wake.isHeld()) wake.release(); } catch (Exception ignored) { /* released */ }
        try { if (wifi != null && wifi.isHeld()) wifi.release(); } catch (Exception ignored) { /* released */ }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
