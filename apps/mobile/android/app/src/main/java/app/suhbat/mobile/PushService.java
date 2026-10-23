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
import androidx.core.app.Person;
import androidx.core.app.RemoteInput;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
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

    static volatile PushService instance;

    /** One line of a conversation shown in its notification. */
    private static class Line {
        String who; String text; long at; long id; boolean mine;
    }

    private final Map<Long, ArrayList<Line>> history = new HashMap<>();
    private final Map<Long, String> names = new HashMap<>();

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
        instance = this;
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
        if (instance == this) instance = null;
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
                case "read":
                    // read on another device (or in the app): the notification of that chat is no longer needed
                    if (ev.optLong("user_id") == myId) forget(ev.optLong("chat_id"));
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
        boolean group = chat != null && !"direct".equals(chat.optString("type"));
        Line l = new Line();
        l.text = body;
        l.at = m.optLong("created_at", System.currentTimeMillis());
        l.id = m.optLong("id");
        l.who = group ? senderName(m.optLong("sender_id"), m.optString("import_author", ""), cookie, origin) : title;
        synchronized (history) {
            ArrayList<Line> h = history.get(chatId);
            if (h == null) { h = new ArrayList<>(); history.put(chatId, h); }
            h.add(l);
            while (h.size() > 8) h.remove(0);
        }
        showChat(chatId, group, title, true);
    }

    private String senderName(long id, String importAuthor, String cookie, String origin) {
        if (!importAuthor.isEmpty()) return importAuthor;
        String known = names.get(id);
        if (known != null) return known;
        try {
            Request r = new Request.Builder().url(origin + "/api/users/" + id).header("Cookie", cookie).build();
            try (Response resp = client.newCall(r).execute()) {
                if (resp.isSuccessful() && resp.body() != null) {
                    String name = new JSONObject(resp.body().string()).getJSONObject("user").optString("name", "");
                    if (!name.isEmpty()) { names.put(id, name); return name; }
                }
            }
        } catch (Exception ignored) { /* the name is cosmetic */ }
        return "";
    }

    /** The notification of one chat: the last lines as a conversation, with "Reply" (typed right in the shade) and "Mark as read". */
    private void showChat(long chatId, boolean group, String title, boolean alert) {
        ArrayList<Line> h;
        synchronized (history) {
            ArrayList<Line> src = history.get(chatId);
            h = src == null ? new ArrayList<>() : new ArrayList<>(src);
        }
        if (h.isEmpty()) return;
        Person me = new Person.Builder().setName("Вы").build();
        NotificationCompat.MessagingStyle style = new NotificationCompat.MessagingStyle(me);
        if (group) { style.setConversationTitle(title); style.setGroupConversation(true); }
        long lastId = 0;
        for (Line l : h) {
            style.addMessage(l.text, l.at, l.mine ? me : new Person.Builder().setName(l.who == null || l.who.isEmpty() ? title : l.who).build());
            lastId = Math.max(lastId, l.id);
        }
        int mutable = Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0;
        int immutable = Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0;
        int code = (int) (chatId % 100000);
        Intent replyIntent = new Intent(this, NotifyActionReceiver.class).setAction(NotifyActionReceiver.ACT_REPLY).putExtra("chat_id", chatId).putExtra("last_id", lastId);
        Intent readIntent = new Intent(this, NotifyActionReceiver.class).setAction(NotifyActionReceiver.ACT_READ).putExtra("chat_id", chatId).putExtra("last_id", lastId);
        Intent gone = new Intent(this, NotifyActionReceiver.class).setAction(NotifyActionReceiver.ACT_DISMISS).putExtra("chat_id", chatId);
        NotificationCompat.Action reply = new NotificationCompat.Action.Builder(R.drawable.ic_stat, "Ответить",
                PendingIntent.getBroadcast(this, 100000 + code, replyIntent, PendingIntent.FLAG_UPDATE_CURRENT | mutable))
                .addRemoteInput(new RemoteInput.Builder(NotifyActionReceiver.KEY_REPLY).setLabel("Ответить").build())
                .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY).setShowsUserInterface(false).build();
        NotificationCompat.Action read = new NotificationCompat.Action.Builder(R.drawable.ic_stat, "Прочитано",
                PendingIntent.getBroadcast(this, 200000 + code, readIntent, PendingIntent.FLAG_UPDATE_CURRENT | immutable))
                .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_MARK_AS_READ).setShowsUserInterface(false).build();
        Notification n = new NotificationCompat.Builder(this, CH_MESSAGES)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(title)
                .setContentText(h.get(h.size() - 1).text)
                .setStyle(style)
                .setNumber(h.size())
                .setAutoCancel(true)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setDefaults(alert ? NotificationCompat.DEFAULT_ALL : 0)
                .setOnlyAlertOnce(!alert)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setContentIntent(openApp((int) chatId))
                .setDeleteIntent(PendingIntent.getBroadcast(this, 300000 + code, gone, PendingIntent.FLAG_UPDATE_CURRENT | immutable))
                .addAction(reply)
                .addAction(read)
                .build();
        ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify((int) (2000 + (chatId % 100000)), n);
    }

    /** The chat is read (here or elsewhere) or the notification was swiped away: forget the lines and remove it. */
    static void forget(long chatId) {
        final PushService s = instance;
        if (s == null) return;
        synchronized (s.history) { s.history.remove(chatId); }
        s.main.post(() -> ((NotificationManager) s.getSystemService(NOTIFICATION_SERVICE)).cancel((int) (2000 + (chatId % 100000))));
    }

    /** After a button of the notification was used: show my answer in the conversation, or say it was not sent. */
    static void afterAction(Context ctx, long chatId, boolean wasReply, String text, boolean ok) {
        final PushService s = instance;
        if (s == null) {
            ((NotificationManager) ctx.getSystemService(NOTIFICATION_SERVICE)).cancel((int) (2000 + (chatId % 100000)));
            return;
        }
        if (!wasReply) { if (ok) forget(chatId); return; }
        Line l = new Line();
        l.mine = true;
        l.at = System.currentTimeMillis();
        l.text = ok ? text : "\u26a0 Не отправлено: " + text;
        synchronized (s.history) {
            ArrayList<Line> h = s.history.get(chatId);
            if (h == null) { h = new ArrayList<>(); s.history.put(chatId, h); }
            h.add(l);
            while (h.size() > 8) h.remove(0);
        }
        JSONObject chat = s.chats.get(chatId);
        final boolean group = chat != null && !"direct".equals(chat.optString("type"));
        String title = "Suhbat-dosh";
        if (chat != null) {
            JSONObject peer = chat.optJSONObject("peer");
            title = !group && peer != null ? peer.optString("name", title) : chat.optString("title", title);
        }
        final String t = title;
        s.main.post(() -> s.showChat(chatId, group, t, false));
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
