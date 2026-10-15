package app.suhbat.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.net.wifi.WifiManager;
import android.webkit.CookieManager;

import androidx.core.app.NotificationCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * Keeps one connection to the user's own Suhbat-dosh server while the app is closed, like Telegram does,
 * and shows messages and incoming calls as system notifications. No Google services are involved.
 * The session cookie is read from the WebView's cookie store, so nothing extra is stored.
 */
public class PushService extends Service {
    static final String PREFS = "suhbat";
    static final String KEY_ORIGIN = "origin";
    static final String CH_SERVICE = "service_quiet";
    static final String CH_MESSAGES = "messages";
    static final String CH_CALLS = "calls";
    static final int ID_SERVICE = 1;
    static final int ID_CALL = 2;

    /** True while the app UI is on screen: then it shows messages itself. */
    static volatile boolean appVisible = false;

    private final Handler main = new Handler(Looper.getMainLooper());
    private OkHttpClient client;
    private WebSocket ws;
    private long myId = 0;
    private int backoff = 2000;
    private boolean stopped = false;
    private final Map<Long, JSONObject> chats = new HashMap<>();
    private long chatsAt = 0;
    private ConnectivityManager.NetworkCallback netCb;
    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;

    @Override
    public void onCreate() {
        super.onCreate();
        client = new OkHttpClient.Builder()
                .pingInterval(25, TimeUnit.SECONDS)
                .readTimeout(0, TimeUnit.MILLISECONDS)
                .retryOnConnectionFailure(true)
                .build();
        makeChannels();
        Notification n = new NotificationCompat.Builder(this, CH_SERVICE)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("Suhbat-dosh")
                .setContentText(getString(R.string.bg_running))
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_MIN)
                .setSilent(true)
                .setShowWhen(false)
                .setVisibility(NotificationCompat.VISIBILITY_SECRET)
                .setContentIntent(openApp(0))
                .build();
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(ID_SERVICE, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING);
        } else {
            startForeground(ID_SERVICE, n);
        }
        // reconnect at once when the network comes back
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            netCb = new ConnectivityManager.NetworkCallback() {
                @Override public void onAvailable(Network network) { main.post(() -> { backoff = 2000; reconnectNow(); }); }
            };
            cm.registerDefaultNetworkCallback(netCb);
        } catch (Exception ignored) { /* optional */ }
        // keep the CPU and Wi-Fi awake while the screen is off, so messages and calls arrive in real time
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "suhbat:connection");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire();
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "suhbat:wifi");
            wifiLock.setReferenceCounted(false);
            wifiLock.acquire();
        } catch (Exception ignored) { /* optional */ }
        connect();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onDestroy() {
        stopped = true;
        main.removeCallbacksAndMessages(null);
        try { if (wakeLock != null && wakeLock.isHeld()) wakeLock.release(); } catch (Exception ignored) { /* ignore */ }
        try { if (wifiLock != null && wifiLock.isHeld()) wifiLock.release(); } catch (Exception ignored) { /* ignore */ }
        if (ws != null) ws.cancel();
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (netCb != null) cm.unregisterNetworkCallback(netCb);
        } catch (Exception ignored) { /* ignore */ }
        super.onDestroy();
    }

    // ------------------------------------------------------------------ connection
    private String origin() {
        return getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_ORIGIN, null);
    }

    private void reconnectNow() {
        if (stopped) return;
        if (ws != null) { ws.cancel(); ws = null; }
        main.removeCallbacks(this::connect);
        connect();
    }

    private void schedule(int ms) {
        main.removeCallbacks(this::connect);
        main.postDelayed(this::connect, ms);
    }

    private void connect() {
        if (stopped) return;
        String o = origin();
        String cookie = o == null ? null : CookieManager.getInstance().getCookie(o);
        if (o == null || cookie == null || !cookie.contains("sid=")) {
            schedule(60_000); // signed out (or not configured yet): look again in a minute
            return;
        }
        String url = (o.startsWith("https") ? "wss" : "ws") + o.substring(o.indexOf("://")) + "/ws";
        Request req = new Request.Builder().url(url).header("Cookie", cookie).build();
        ws = client.newWebSocket(req, new WebSocketListener() {
            @Override public void onOpen(WebSocket w, Response r) { backoff = 2000; }
            @Override public void onMessage(WebSocket w, String text) { handle(text, cookie, o); }
            @Override public void onClosed(WebSocket w, int code, String reason) {
                if (code == 4001) { schedule(60_000); return; } // session revoked
                retry();
            }
            @Override public void onFailure(WebSocket w, Throwable t, Response r) {
                if (r != null && r.code() == 401) { schedule(60_000); return; }
                retry();
            }
        });
    }

    private void retry() {
        if (stopped) return;
        int d = backoff;
        backoff = Math.min(backoff * 2, 60_000);
        main.post(() -> schedule(d));
    }

    // ------------------------------------------------------------------ events
    private void handle(String text, String cookie, String origin) {
        try {
            JSONObject ev = new JSONObject(text);
            String type = ev.optString("type");
            switch (type) {
                case "ready":
                    myId = ev.optLong("user_id");
                    loadChats(cookie, origin);
                    break;
                case "chat.update": {
                    JSONObject c = ev.optJSONObject("chat");
                    if (c != null) chats.put(c.optLong("id"), c);
                    break;
                }
                case "chat.remove":
                    chats.remove(ev.optLong("chat_id"));
                    break;
                case "message.new":
                    onMessage(ev.optJSONObject("message"), cookie, origin);
                    break;
                case "call.incoming":
                    onCall(ev);
                    break;
                case "call.ended":
                    ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).cancel(ID_CALL);
                    break;
                case "session.revoked":
                    schedule(60_000);
                    break;
                default:
            }
        } catch (Exception ignored) { /* a malformed event is skipped */ }
    }

    private void loadChats(String cookie, String origin) {
        try {
            Request r = new Request.Builder().url(origin + "/api/chats").header("Cookie", cookie).build();
            try (Response resp = client.newCall(r).execute()) {
                if (!resp.isSuccessful() || resp.body() == null) return;
                JSONArray arr = new JSONObject(resp.body().string()).optJSONArray("chats");
                chats.clear();
                if (arr != null) for (int i = 0; i < arr.length(); i++) {
                    JSONObject c = arr.getJSONObject(i);
                    chats.put(c.optLong("id"), c);
                }
                chatsAt = System.currentTimeMillis();
            }
        } catch (Exception ignored) { /* retried on the next event */ }
    }

    private void onMessage(JSONObject m, String cookie, String origin) {
        if (m == null || appVisible || m.optBoolean("silent")) return;
        if (m.optLong("sender_id") == myId) return;
        String kind = m.optString("kind");
        if ("call".equals(kind)) return;
        long chatId = m.optLong("chat_id");
        JSONObject chat = chats.get(chatId);
        if (chat == null && System.currentTimeMillis() - chatsAt > 5000) {
            loadChats(cookie, origin);
            chat = chats.get(chatId);
        }
        if (chat != null) {
            if (chat.optBoolean("muted")) return;
            long until = chat.optLong("muted_until", 0);
            if (until > System.currentTimeMillis()) return;
        }
        String title = "Suhbat-dosh";
        if (chat != null) {
            JSONObject peer = chat.optJSONObject("peer");
            if ("direct".equals(chat.optString("type")) && peer != null) title = peer.optString("name", title);
            else title = chat.optString("title", title);
        }
        String body = m.optString("text", "");
        if (body.isEmpty()) {
            switch (kind) {
                case "image": body = "🖼 Фото"; break;
                case "video": body = "🎬 Видео"; break;
                case "voice": body = "🎤 Голосовое сообщение"; break;
                case "audio": body = "🎵 Аудио"; break;
                case "file": body = "📎 Файл"; break;
                default: body = "Новое сообщение";
            }
        } else if (body.length() > 160) {
            body = body.substring(0, 160);
        }
        Notification n = new NotificationCompat.Builder(this, CH_MESSAGES)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setDefaults(NotificationCompat.DEFAULT_ALL)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setContentIntent(openApp((int) chatId))
                .build();
        ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify((int) (2000 + (chatId % 100000)), n);
    }

    private void onCall(JSONObject ev) {
        if (appVisible) return;
        JSONObject from = ev.optJSONObject("from");
        String name = from != null ? from.optString("name", "") : "";
        boolean video = ev.optBoolean("video");
        Notification n = new NotificationCompat.Builder(this, CH_CALLS)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(name.isEmpty() ? "Suhbat-dosh" : name)
                .setContentText(video ? "Входящий видеозвонок" : "Входящий звонок")
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setOngoing(true)
                .setTimeoutAfter(45_000)
                .setContentIntent(openCall())
                .setFullScreenIntent(openCall(), true)
                .build();
        ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify(ID_CALL, n);
    }

    /** Opens the app over the lock screen so the incoming call can be answered right away. */
    private PendingIntent openCall() {
        Intent i = new Intent(this, MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        i.putExtra("incoming_call", true);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        return PendingIntent.getActivity(this, 9001, i, flags);
    }

    private PendingIntent openApp(int chatId) {
        Intent i = new Intent(this, MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (chatId > 0) i.putExtra("chat_id", chatId);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        return PendingIntent.getActivity(this, chatId, i, flags);
    }

    private void makeChannels() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        // the connection notice Android insists on is created blocked: the service keeps running, nothing is shown
        nm.deleteNotificationChannel("service");
        NotificationChannel s = new NotificationChannel(CH_SERVICE, getString(R.string.ch_service), NotificationManager.IMPORTANCE_NONE);
        s.setShowBadge(false);
        s.setLockscreenVisibility(Notification.VISIBILITY_SECRET);
        NotificationChannel m = new NotificationChannel(CH_MESSAGES, getString(R.string.ch_messages), NotificationManager.IMPORTANCE_HIGH);
        NotificationChannel c = new NotificationChannel(CH_CALLS, getString(R.string.ch_calls), NotificationManager.IMPORTANCE_HIGH);
        c.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
                new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).build());
        c.enableVibration(true);
        c.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        m.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        m.enableVibration(true);
        nm.createNotificationChannel(s);
        nm.createNotificationChannel(m);
        nm.createNotificationChannel(c);
    }
}
