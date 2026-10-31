package app.suhbat.mobile;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.LocationManager;
import android.net.Uri;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.webkit.MimeTypeMap;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import androidx.annotation.NonNull;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;

import com.google.android.gms.common.ConnectionResult;
import com.google.android.gms.common.GoogleApiAvailability;
import com.google.android.gms.nearby.Nearby;
import com.google.android.gms.nearby.connection.AdvertisingOptions;
import com.google.android.gms.nearby.connection.ConnectionInfo;
import com.google.android.gms.nearby.connection.ConnectionLifecycleCallback;
import com.google.android.gms.nearby.connection.ConnectionOptions;
import com.google.android.gms.nearby.connection.ConnectionResolution;
import com.google.android.gms.nearby.connection.ConnectionsClient;
import com.google.android.gms.nearby.connection.ConnectionsStatusCodes;
import com.google.android.gms.nearby.connection.DiscoveredEndpointInfo;
import com.google.android.gms.nearby.connection.DiscoveryOptions;
import com.google.android.gms.nearby.connection.EndpointDiscoveryCallback;
import com.google.android.gms.nearby.connection.Payload;
import com.google.android.gms.nearby.connection.PayloadCallback;
import com.google.android.gms.nearby.connection.PayloadTransferUpdate;
import com.google.android.gms.nearby.connection.Strategy;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.DigestInputStream;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Direct transfers between phones that are near each other, with no internet (Google Nearby Connections: Bluetooth + Wi-Fi).
 * One object for the whole process: a transfer goes on when the page reloads or the activity is recreated.
 *
 * A file: the sender offers it; the receiver answers with how many bytes it already has; the rest comes as a stream, followed by
 * the SHA-256 of the whole file. A broken connection leaves the received part on disk, and the transfer continues from
 * there when the two phones meet again. The page handles connections, identity and texts (window.__nearby / nearby.js).
 */
final class NearbyBridge {
    static final int REQ_PICK = 7001;
    static final int REQ_PERM = 7002;
    // a new id: the older app versions use a slower strategy and could not connect to this one anyway
    private static final String SERVICE_ID = "app.suhbat.nearby.v2";
    // the widest strategy that still lets one phone serve many (a room); Cluster, used before, is the slowest
    private static final Strategy STRATEGY = Strategy.P2P_STAR;
    private static final int MAX_BYTES = 30000; // Nearby allows 32 KB for a bytes payload
    private static final int BUF = 256 * 1024;
    private static NearbyBridge one;

    private final Context app;
    private final NearbyStore store;
    private final Handler main = new Handler(Looper.getMainLooper());
    private Activity activity;
    private WebView web;
    private ConnectionsClient client;
    private boolean advertising = false;
    private boolean discovering = false;
    private String myName = "";

    private static final class Peer {
        String id, name = "", did = "", code = "", label = "";
        boolean connected, trusted, roomHost, roomGuest;
        boolean ready;   // nothing is sent before the page knows who this is
        String shown() { return label.isEmpty() ? name : label; }
    }

    private final Map<String, Peer> peers = new ConcurrentHashMap<>();   // endpoint id -> peer
    private final Set<String> found = ConcurrentHashMap.newKeySet();
    private final Set<String> joining = ConcurrentHashMap.newKeySet();
    private String roomName = null;

    // sending
    private static final class Outgoing {
        String tid, eid;
        long payloadId, offset, size;
        MessageDigest digest;
        InputStream in;
    }
    private final Map<Long, Outgoing> sending = new ConcurrentHashMap<>();
    private final Set<String> busyPeers = ConcurrentHashMap.newKeySet();

    // receiving: the stream and its description may come in any order
    private final Map<Long, InputStream> streams = new ConcurrentHashMap<>();
    private final Map<Long, String> starts = new ConcurrentHashMap<>();
    private final Map<String, String> shaOf = new ConcurrentHashMap<>();
    private final Set<String> complete = ConcurrentHashMap.newKeySet();

    private final Map<String, long[]> speed = new ConcurrentHashMap<>();  // tid -> { bytes, time } of the previous report
    private List<String> pickTargets = null;
    private long pickChat = 0;
    private final List<Uri> shared = new ArrayList<>();
    private String sharedText = null;

    LocalShare room;

    static synchronized NearbyBridge get(Context c) {
        if (one == null) one = new NearbyBridge(c.getApplicationContext());
        return one;
    }

    private NearbyBridge(Context c) {
        app = c;
        store = new NearbyStore(c);
        // whatever was moving when the process ended is resumable, not lost
        for (JSONObject o : list(store.unfinished())) setState(o.optString("tid"), "paused", null);
    }

    void attach(Activity a, WebView w) {
        activity = a;
        web = w;
    }

    private static List<JSONObject> list(JSONArray a) {
        List<JSONObject> out = new ArrayList<>();
        for (int i = 0; i < a.length(); i++) out.add(a.optJSONObject(i));
        return out;
    }

    // ------------------------------------------------------------------ small settings shared by the messenger and the offline page
    private android.content.SharedPreferences prefs() {
        return app.getSharedPreferences("nearby", Context.MODE_PRIVATE);
    }

    String kvGet(String k) { return prefs().getString(k, ""); }
    void kvSet(String k, String v) { prefs().edit().putString(k, v).apply(); }

    String deviceId() {
        String id = kvGet("did");
        if (id.isEmpty()) {
            id = UUID.randomUUID().toString().substring(0, 8);
            kvSet("did", id);
        }
        return id;
    }

    // ------------------------------------------------------------------ availability and permissions
    boolean supported() {
        try {
            return GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(app) == ConnectionResult.SUCCESS;
        } catch (Throwable t) { return false; }
    }

    private String[] needed() {
        if (Build.VERSION.SDK_INT >= 33) {
            return new String[]{Manifest.permission.BLUETOOTH_ADVERTISE, Manifest.permission.BLUETOOTH_CONNECT,
                    Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.NEARBY_WIFI_DEVICES};
        }
        if (Build.VERSION.SDK_INT >= 31) {
            return new String[]{Manifest.permission.BLUETOOTH_ADVERTISE, Manifest.permission.BLUETOOTH_CONNECT,
                    Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.ACCESS_FINE_LOCATION};
        }
        return new String[]{Manifest.permission.ACCESS_FINE_LOCATION};
    }

    boolean hasPermissions() {
        for (String p : needed()) if (ContextCompat.checkSelfPermission(app, p) != PackageManager.PERMISSION_GRANTED) return false;
        return true;
    }

    private void askPermissions() {
        Activity a = activity;
        if (a != null) ActivityCompat.requestPermissions(a, needed(), REQ_PERM);
    }

    /** What is switched off: the page says what to turn on instead of searching for nothing. */
    String radios() {
        JSONObject o = new JSONObject();
        try {
            WifiManager w = (WifiManager) app.getSystemService(Context.WIFI_SERVICE);
            o.put("wifi", w != null && w.isWifiEnabled());
            android.bluetooth.BluetoothManager b = (android.bluetooth.BluetoothManager) app.getSystemService(Context.BLUETOOTH_SERVICE);
            o.put("bt", b != null && b.getAdapter() != null && b.getAdapter().isEnabled());
            boolean loc = true;
            if (Build.VERSION.SDK_INT < 33) {
                LocationManager lm = (LocationManager) app.getSystemService(Context.LOCATION_SERVICE);
                if (lm != null && Build.VERSION.SDK_INT >= 28) loc = lm.isLocationEnabled();
            }
            o.put("loc", loc);
        } catch (Exception ignored) { /* what was found */ }
        return o.toString();
    }

    /** "ok" when it started, "permissions" when the system dialog was shown (the page asks again after the "perm" event). */
    String start(String name, boolean advertise, boolean discover) {
        if (!supported()) return "unsupported";
        myName = (name == null || name.isEmpty()) ? "Suhbat" : name;
        if (!hasPermissions()) {
            askPermissions();
            return "permissions";
        }
        client = Nearby.getConnectionsClient(app);
        // the name is part of what is advertised: a changed name (the visibility changed) needs a new advertisement
        stopFindingQuietly();
        if (advertise) advertise();
        if (discover) {
            discovering = true;
            client.startDiscovery(SERVICE_ID, discovery, new DiscoveryOptions.Builder().setStrategy(STRATEGY).build())
                    .addOnFailureListener(e -> fail("discover", e));
        }
        emit(obj("type", "started"));
        return "ok";
    }

    private void advertise() {
        advertising = true;
        client.startAdvertising(myName, SERVICE_ID, lifecycle,
                new AdvertisingOptions.Builder().setStrategy(STRATEGY).setDisruptiveUpgrade(true).build())
                .addOnFailureListener(e -> fail("advertise", e));
    }

    void onPermissionResult(int[] results) {
        boolean all = results.length > 0;
        for (int r : results) if (r != PackageManager.PERMISSION_GRANTED) all = false;
        emit(obj("type", "perm", "granted", all ? "1" : "0"));
    }

    private void stopFindingQuietly() {
        found.clear();
        if (client == null) return;
        try { client.stopAdvertising(); } catch (Throwable ignored) { /* not running */ }
        try { client.stopDiscovery(); } catch (Throwable ignored) { /* not running */ }
        advertising = false;
        discovering = false;
    }

    /** Stop being visible and searching; the connections that exist stay. */
    void stopFinding() {
        stopFindingQuietly();
        if (roomName != null && client != null) advertise(); // an open room stays visible
        emit(obj("type", "stopped"));
    }

    void stopAll() {
        stopFinding();
        if (client != null) { try { client.stopAllEndpoints(); } catch (Throwable ignored) { /* none */ } }
        for (Peer p : peers.values()) onGone(p);
        peers.clear();
    }

    String state() {
        JSONObject o = new JSONObject();
        try {
            JSONArray f = new JSONArray();
            for (String id : found) {
                Peer p = peers.get(id);
                if (p != null && !p.connected) f.put(new JSONObject().put("id", id).put("name", p.name));
            }
            JSONArray c = new JSONArray();
            for (Peer p : peers.values()) {
                if (p.connected) c.put(new JSONObject().put("id", p.id).put("name", p.name).put("label", p.label).put("code", p.code).put("trusted", p.trusted).put("room", p.roomHost));
            }
            o.put("found", f).put("connected", c).put("searching", discovering || advertising).put("transfers", store.unfinished());
        } catch (Exception ignored) { /* what was built */ }
        return o.toString();
    }

    // ------------------------------------------------------------------ connections
    private final EndpointDiscoveryCallback discovery = new EndpointDiscoveryCallback() {
        @Override public void onEndpointFound(@NonNull String id, @NonNull DiscoveredEndpointInfo info) {
            peer(id, info.getEndpointName());
            found.add(id);
            emit(obj("type", "found", "id", id, "name", info.getEndpointName()));
        }
        @Override public void onEndpointLost(@NonNull String id) {
            found.remove(id);
            Peer p = peers.get(id);
            if (p != null && !p.connected) peers.remove(id);
            emit(obj("type", "lost", "id", id));
        }
    };

    private Peer peer(String id, String name) {
        Peer p = peers.get(id);
        if (p == null) { p = new Peer(); p.id = id; peers.put(id, p); }
        if (name != null) {
            p.name = name;
            int i = name.indexOf('|');
            p.did = i > 0 ? name.substring(0, i) : name;
        }
        return p;
    }

    private final ConnectionLifecycleCallback lifecycle = new ConnectionLifecycleCallback() {
        @Override public void onConnectionInitiated(@NonNull String id, @NonNull ConnectionInfo info) {
            Peer p = peer(id, info.getEndpointName());
            p.code = info.getAuthenticationDigits();
            if (joining.remove(id)) { // we asked to join this room
                p.roomHost = true;
                p.trusted = true;
                p.ready = true;
                accept(id);
                return;
            }
            if (roomName != null && info.isIncomingConnection()) { // whoever comes to an open room gets in
                p.roomGuest = true;
                p.trusted = true;
                p.ready = true;
                accept(id);
                return;
            }
            // both phones show the same 4 digits: the people compare them (protection against someone in the middle)
            emit(obj("type", "request", "id", id, "name", info.getEndpointName(), "code", info.getAuthenticationDigits(),
                    "incoming", info.isIncomingConnection() ? "1" : "0"));
        }
        @Override public void onConnectionResult(@NonNull String id, @NonNull ConnectionResolution r) {
            int code = r.getStatus().getStatusCode();
            Peer p = peers.get(id);
            if (code == ConnectionsStatusCodes.STATUS_OK && p != null) {
                p.connected = true;
                found.remove(id);
                // searching takes radio time away from the transfer; an open room must stay visible
                if (client != null) {
                    try { client.stopDiscovery(); } catch (Throwable ignored) { /* not running */ }
                    discovering = false;
                    if (roomName == null) { try { client.stopAdvertising(); } catch (Throwable ignored) { /* not running */ } advertising = false; }
                }
                emit(obj("type", "connected", "id", id, "name", p.name, "code", p.code, "room", p.roomHost ? "1" : "0", "guest", p.roomGuest ? "1" : "0"));
                if (p.roomGuest && room != null) room.onGuestJoined(p.did);
                pump(p.did);
            } else {
                emit(obj("type", "refused", "id", id, "code", String.valueOf(code)));
            }
        }
        @Override public void onDisconnected(@NonNull String id) {
            Peer p = peers.remove(id);
            if (p != null) onGone(p);
            emit(obj("type", "disconnected", "id", id));
        }
    };

    /** Everything under way with this peer waits for the next meeting. */
    private void onGone(Peer p) {
        busyPeers.remove(p.did);
        for (Map.Entry<Long, Outgoing> e : new HashMap<>(sending).entrySet()) {
            if (p.id.equals(e.getValue().eid)) {
                sending.remove(e.getKey());
                closeQuietly(e.getValue().in);
            }
        }
        for (JSONObject o : list(store.unfinished())) {
            if (p.did.equals(o.optString("peer")) && !"verifying".equals(o.optString("state"))) setState(o.optString("tid"), "paused", null);
        }
        refreshService();
    }

    void connect(String id) {
        if (client == null) client = Nearby.getConnectionsClient(app);
        client.requestConnection(myName, id, lifecycle, new ConnectionOptions.Builder().setDisruptiveUpgrade(true).build())
                .addOnFailureListener(e -> fail("connect", e));
    }

    void joinRoom(String id) {
        joining.add(id);
        connect(id);
    }

    void accept(String id) {
        if (client != null) client.acceptConnection(id, payloads).addOnFailureListener(e -> fail("accept", e));
    }

    void reject(String id) {
        if (client != null) client.rejectConnection(id);
    }

    void disconnect(String id) {
        if (client != null) client.disconnectFromEndpoint(id);
        Peer p = peers.remove(id);
        if (p != null) onGone(p);
        emit(obj("type", "disconnected", "id", id));
    }

    /** The page checked this peer's signed identity (a contact): files from it need no question. */
    void trust(String id) {
        Peer p = peers.get(id);
        if (p == null) return;
        p.trusted = true;
        ready(id);
    }

    /** The page knows who this is (a signed identity, or the people compared the digits): queued files may go. */
    void ready(String id) {
        Peer p = peers.get(id);
        if (p == null) return;
        p.ready = true;
        pump(p.did);
    }

    /** The name to keep in the history instead of what the phone says about itself over the air. */
    void label(String id, String name) {
        Peer p = peers.get(id);
        if (p != null && name != null) p.label = name;
    }

    private Peer connectedByDid(String did) {
        for (Peer p : peers.values()) if (p.connected && did.equals(p.did)) return p;
        return null;
    }

    // ------------------------------------------------------------------ texts and control messages
    boolean sendBytes(String id, String text) {
        if (client == null || text == null) return false;
        byte[] data = text.getBytes(StandardCharsets.UTF_8);
        if (data.length > MAX_BYTES) return false;
        client.sendPayload(id, Payload.fromBytes(data)).addOnFailureListener(e -> fail("send", e));
        return true;
    }

    private void control(String eid, String... kv) {
        if (client == null) return;
        client.sendPayload(eid, Payload.fromBytes(obj(kv).toString().getBytes(StandardCharsets.UTF_8)));
    }

    /** A text message kept next to the files of the conversation. */
    long saveText(String peer, String peerName, String dir, String text, long chatId) {
        ContentValues v = new ContentValues();
        v.put("peer", peer);
        v.put("peer_name", peerName);
        v.put("dir", dir);
        v.put("kind", "text");
        v.put("text", text);
        v.put("ts", System.currentTimeMillis());
        v.put("chat_id", chatId);
        return store.insert(v);
    }

    // ------------------------------------------------------------------ choosing what to send
    void pickFiles(String targetsJson, long chatId) {
        Activity a = activity;
        if (a == null) return;
        pickTargets = parseTargets(targetsJson);
        pickChat = chatId;
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("*/*");
        i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        a.startActivityForResult(i, REQ_PICK);
    }

    private static List<String> parseTargets(String json) {
        List<String> out = new ArrayList<>();
        try {
            JSONArray a = new JSONArray(json);
            for (int i = 0; i < a.length(); i++) out.add(a.getString(i));
        } catch (Exception ignored) { /* none */ }
        return out;
    }

    void onFilePicked(int resultCode, Intent data) {
        final List<String> targets = pickTargets;
        final long chat = pickChat;
        pickTargets = null;
        if (resultCode != Activity.RESULT_OK || data == null || targets == null) return;
        List<Uri> uris = new ArrayList<>();
        ClipData clip = data.getClipData();
        if (clip != null) for (int i = 0; i < clip.getItemCount(); i++) uris.add(clip.getItemAt(i).getUri());
        else if (data.getData() != null) uris.add(data.getData());
        for (Uri u : uris) {
            // so that a transfer can continue after the app was closed
            try { app.getContentResolver().takePersistableUriPermission(u, Intent.FLAG_GRANT_READ_URI_PERMISSION); } catch (Exception ignored) { /* a one-time grant */ }
            sendUri(u, targets, chat);
        }
    }

    private void sendUri(Uri u, List<String> targets, long chat) {
        String name = displayName(u);
        long size = sizeOf(u);
        String mime = app.getContentResolver().getType(u);
        for (String did : targets) {
            if ("room".equals(did)) { if (room != null) room.addUri(u, name, size, mime); }
            else enqueue(did, u.toString(), null, name, size, mime, chat);
        }
    }

    /** Files handed over from another app with "Share". */
    void setShared(List<Uri> uris, String text) {
        shared.clear();
        shared.addAll(uris);
        sharedText = text;
        emit(obj("type", "shared"));
    }

    String sharedInfo() {
        JSONObject o = new JSONObject();
        JSONArray a = new JSONArray();
        try {
            for (int i = 0; i < shared.size(); i++) {
                Uri u = shared.get(i);
                a.put(new JSONObject().put("i", i).put("name", displayName(u)).put("size", sizeOf(u)).put("mime", String.valueOf(app.getContentResolver().getType(u))));
            }
            o.put("files", a);
            if (sharedText != null) o.put("text", sharedText);
        } catch (Exception ignored) { /* what was built */ }
        return o.toString();
    }

    void clearShared() {
        shared.clear();
        sharedText = null;
    }

    void sendShared(String targetsJson) {
        List<String> targets = parseTargets(targetsJson);
        for (Uri u : new ArrayList<>(shared)) sendUri(u, targets, 0);
        clearShared();
    }

    private String displayName(Uri uri) {
        try (android.database.Cursor c = app.getContentResolver().query(uri, null, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int ix = c.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME);
                if (ix >= 0 && c.getString(ix) != null) return safe(c.getString(ix));
            }
        } catch (Exception ignored) { /* fall through */ }
        String last = uri.getLastPathSegment();
        return safe(last == null ? "file" : last);
    }

    private long sizeOf(Uri uri) {
        try (android.os.ParcelFileDescriptor pfd = app.getContentResolver().openFileDescriptor(uri, "r")) {
            if (pfd != null) return Math.max(0, pfd.getStatSize());
        } catch (Exception ignored) { /* unknown */ }
        return 0;
    }

    private static String safe(String n) {
        String s = n == null ? "file" : n.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        if (s.isEmpty() || s.equals(".") || s.equals("..")) return "file";
        return s.length() > 120 ? s.substring(s.length() - 120) : s;
    }

    // ------------------------------------------------------------------ sending
    /** Queues a file (a content address or a file of ours) for a peer; it starts as soon as that peer is connected. */
    void enqueue(String did, String uri, String path, String name, long size, String mime, long chat) {
        Peer p = connectedByDid(did);
        ContentValues v = new ContentValues();
        String tid = UUID.randomUUID().toString();
        v.put("tid", tid);
        v.put("peer", did);
        v.put("peer_name", p == null ? recentName(did) : p.shown());
        v.put("dir", "out");
        v.put("kind", "file");
        v.put("name", name);
        v.put("size", size);
        v.put("mime", mime);
        v.put("state", "pending");
        v.put("uri", uri);
        v.put("path", path);
        v.put("ts", System.currentTimeMillis());
        v.put("chat_id", chat);
        store.insert(v);
        emitItem(tid);
        pump(did);
    }

    private String recentName(String did) {
        for (JSONObject o : list(store.peers())) if (did.equals(o.optString("id"))) return o.optString("name");
        return did;
    }

    /** One file at a time for each peer. */
    private void pump(String did) {
        Peer p = connectedByDid(did);
        if (p == null || !p.ready || !busyPeers.add(did)) return;
        JSONArray rows = store.outgoingFor(did);
        if (rows.length() == 0) { busyPeers.remove(did); refreshService(); return; }
        JSONObject o = rows.optJSONObject(0);
        String tid = o.optString("tid");
        setState(tid, "offered", null);
        control(p.id, "k", "offer", "tid", tid, "name", o.optString("name"), "size", String.valueOf(o.optLong("size")), "mime", o.optString("mime", ""));
        refreshService();
    }

    private InputStream openSource(JSONObject row) throws IOException {
        String path = row.isNull("path") ? null : row.optString("path");
        if (path != null && !path.isEmpty()) return new FileInputStream(path);
        InputStream in = app.getContentResolver().openInputStream(Uri.parse(row.optString("uri")));
        if (in == null) throw new IOException("no source");
        return in;
    }

    private void startSend(String eid, String tid, long offset) {
        JSONObject row = store.byTid(tid);
        if (row == null) return;
        new Thread(() -> {
            try {
                MessageDigest md = MessageDigest.getInstance("SHA-256");
                InputStream raw = openSource(row);
                // the receiver checks the whole file, so the part it already has counts too
                byte[] buf = new byte[BUF];
                long left = offset;
                while (left > 0) {
                    int n = raw.read(buf, 0, (int) Math.min(buf.length, left));
                    if (n <= 0) throw new IOException("source is shorter");
                    md.update(buf, 0, n);
                    left -= n;
                }
                InputStream in = new DigestInputStream(raw, md);
                Payload p = Payload.fromStream(in);
                Outgoing o = new Outgoing();
                o.tid = tid; o.eid = eid; o.payloadId = p.getId(); o.offset = offset; o.size = row.optLong("size"); o.digest = md; o.in = raw;
                sending.put(p.getId(), o);
                setState(tid, "active", null);
                control(eid, "k", "start", "tid", tid, "pid", String.valueOf(p.getId()));
                client.sendPayload(eid, p).addOnFailureListener(e -> { fail("send", e); pauseSend(o); });
            } catch (Exception e) {
                setState(tid, "failed", "source");
                emit(obj("type", "transfer_failed", "tid", tid));
                finishPeerTurn(row.optString("peer"));
            }
        }, "nearby-send").start();
    }

    private void pauseSend(Outgoing o) {
        sending.remove(o.payloadId);
        closeQuietly(o.in);
        setState(o.tid, "paused", null);
    }

    private void finishPeerTurn(String did) {
        busyPeers.remove(did);
        pump(did);
    }

    private static String hex(byte[] d) {
        StringBuilder sb = new StringBuilder();
        for (byte x : d) sb.append(String.format("%02x", x));
        return sb.toString();
    }

    private static void closeQuietly(InputStream in) {
        try { if (in != null) in.close(); } catch (Exception ignored) { /* closed */ }
    }

    void cancel(String tid) {
        JSONObject row = store.byTid(tid);
        if (row == null) return;
        Peer p = connectedByDid(row.optString("peer"));
        for (Outgoing o : new ArrayList<>(sending.values())) {
            if (tid.equals(o.tid)) {
                if (client != null) client.cancelPayload(o.payloadId);
                sending.remove(o.payloadId);
                closeQuietly(o.in);
            }
        }
        if (p != null) control(p.id, "k", "cancel", "tid", tid);
        setState(tid, "failed", "cancelled");
        new File(partsDir(), tid).delete();
        finishPeerTurn(row.optString("peer"));
    }

    void retry(String tid) {
        JSONObject row = store.byTid(tid);
        if (row == null || !"out".equals(row.optString("dir"))) return;
        setState(tid, "pending", null);
        busyPeers.remove(row.optString("peer"));
        pump(row.optString("peer"));
    }

    // ------------------------------------------------------------------ receiving
    private File dir() {
        File d = new File(app.getFilesDir(), "nearby");
        //noinspection ResultOfMethodCallIgnored
        d.mkdirs();
        return d;
    }

    private File partsDir() {
        File d = new File(dir(), ".parts");
        //noinspection ResultOfMethodCallIgnored
        d.mkdirs();
        return d;
    }

    private final PayloadCallback payloads = new PayloadCallback() {
        @Override public void onPayloadReceived(@NonNull String id, @NonNull Payload p) {
            if (p.getType() == Payload.Type.BYTES && p.asBytes() != null) {
                String s = new String(p.asBytes(), StandardCharsets.UTF_8);
                if (!control(id, s)) emit(obj("type", "bytes", "id", id, "data", s));
            } else if (p.getType() == Payload.Type.STREAM && p.asStream() != null) {
                streams.put(p.getId(), p.asStream().asInputStream());
                tryReceive(id, p.getId());
            }
        }

        @Override public void onPayloadTransferUpdate(@NonNull String id, @NonNull PayloadTransferUpdate u) {
            Outgoing o = sending.get(u.getPayloadId());
            if (o == null) return;
            int status = u.getStatus();
            if (status == PayloadTransferUpdate.Status.IN_PROGRESS) {
                report(o.tid, o.offset + u.getBytesTransferred(), o.size);
            } else if (status == PayloadTransferUpdate.Status.SUCCESS) {
                sending.remove(u.getPayloadId());
                closeQuietly(o.in);
                setState(o.tid, "verifying", null);
                control(o.eid, "k", "done", "tid", o.tid, "sha", hex(o.digest.digest()));
            } else {
                pauseSend(o);
                emit(obj("type", "transfer_paused", "tid", o.tid));
                Peer p = peers.get(id);
                if (p != null) busyPeers.remove(p.did);
            }
        }
    };

    /** The file protocol; false for anything the page should read. */
    private boolean control(String eid, String s) {
        JSONObject j;
        try { j = new JSONObject(s); } catch (Exception e) { return false; }
        String k = j.optString("k");
        String tid = j.optString("tid");
        Peer p = peers.get(eid);
        if (p == null) return true;
        switch (k) {
            case "offer": onOffer(p, j); return true;
            case "accept": startSend(eid, tid, Math.max(0, parseLong(j.optString("offset")))); return true;
            case "decline":
                setState(tid, "failed", j.optString("why", "declined"));
                emit(obj("type", "declined", "tid", tid, "why", j.optString("why", "declined")));
                finishPeerTurn(p.did);
                return true;
            case "start":
                long pid = parseLong(j.optString("pid"));
                starts.put(pid, tid);
                tryReceive(eid, pid);
                return true;
            case "done":
                shaOf.put(tid, j.optString("sha"));
                tryVerify(eid, tid);
                return true;
            case "ack":
                if ("1".equals(j.optString("ok"))) {
                    JSONObject row = store.byTid(tid);
                    ContentValues v = new ContentValues();
                    v.put("state", "done");
                    if (row != null) v.put("done", row.optLong("size"));
                    store.update(tid, v);
                    emitItem(tid);
                    emit(obj("type", "sent", "tid", tid));
                } else {
                    setState(tid, "failed", "corrupt");
                    emit(obj("type", "transfer_failed", "tid", tid));
                }
                finishPeerTurn(p.did);
                return true;
            case "cancel":
                setState(tid, "failed", "cancelled");
                new File(partsDir(), tid).delete();
                refreshService();
                return true;
            default:
                return false;
        }
    }

    private static long parseLong(String s) {
        try { return Long.parseLong(s); } catch (Exception e) { return 0; }
    }

    private void onOffer(Peer p, JSONObject j) {
        String tid = j.optString("tid");
        // ids come from the other phone: only a plain id may become a file name
        if (!tid.matches("[0-9a-fA-F-]{36}")) return;
        long size = parseLong(j.optString("size"));
        JSONObject row = store.byTid(tid);
        if (row != null && "done".equals(row.optString("state"))) { // the answer to an earlier transfer was lost
            control(p.id, "k", "ack", "tid", tid, "ok", "1");
            return;
        }
        File part = new File(partsDir(), tid);
        if (dir().getUsableSpace() < size - part.length() + 16 * 1024 * 1024) {
            control(p.id, "k", "decline", "tid", tid, "why", "nospace");
            emit(obj("type", "nospace", "name", j.optString("name"), "size", String.valueOf(size)));
            return;
        }
        boolean resume = row != null && !"failed".equals(row.optString("state"));
        if (row == null) {
            ContentValues v = new ContentValues();
            v.put("tid", tid);
            v.put("peer", p.did);
            v.put("peer_name", p.shown());
            v.put("dir", "in");
            v.put("kind", "file");
            v.put("name", safe(j.optString("name", "file")));
            v.put("size", size);
            String mime = j.optString("mime", "");
            v.put("mime", mime.length() > 100 ? "" : mime);
            v.put("state", "offered");
            v.put("ts", System.currentTimeMillis());
            v.put("room", p.roomHost || roomName != null ? 1 : 0);
            store.insert(v);
        } else {
            ContentValues v = new ContentValues();
            v.put("state", "offered");
            store.update(tid, v);
        }
        emitItem(tid);
        if (p.trusted || resume) acceptFile(tid, true);
        else emit(obj("type", "offer", "id", p.id, "tid", tid, "name", j.optString("name"), "size", String.valueOf(size), "mime", j.optString("mime", "")));
    }

    /** The person's answer (or the automatic one for a contact) to an offered file. */
    void acceptFile(String tid, boolean yes) {
        JSONObject row = store.byTid(tid);
        if (row == null) return;
        Peer p = connectedByDid(row.optString("peer"));
        if (!yes) {
            setState(tid, "failed", "declined");
            if (p != null) control(p.id, "k", "decline", "tid", tid, "why", "declined");
            new File(partsDir(), tid).delete();
            return;
        }
        if (p == null) return;
        complete.remove(tid);
        setState(tid, "active", null);
        control(p.id, "k", "accept", "tid", tid, "offset", String.valueOf(new File(partsDir(), tid).length()));
        refreshService();
    }

    private void tryReceive(String eid, long pid) {
        InputStream in = streams.get(pid);
        String tid = starts.get(pid);
        if (in == null || tid == null) return;
        streams.remove(pid);
        starts.remove(pid);
        JSONObject row = store.byTid(tid);
        if (row == null) { closeQuietly(in); return; }
        final long size = row.optLong("size");
        new Thread(() -> {
            File part = new File(partsDir(), tid);
            long have = part.length();
            try (InputStream src = in; FileOutputStream dst = new FileOutputStream(part, true)) {
                byte[] buf = new byte[BUF];
                int n;
                while ((n = src.read(buf)) > 0) {
                    dst.write(buf, 0, n);
                    have += n;
                    report(tid, have, size);
                }
            } catch (IOException e) {
                /* the connection broke: what arrived stays for the next meeting */
            }
            if (have >= size) {
                complete.add(tid);
                setState(tid, "verifying", null);
                tryVerify(eid, tid);
            } else {
                setState(tid, "paused", null);
                refreshService();
            }
        }, "nearby-recv").start();
    }

    private void tryVerify(String eid, String tid) {
        String sha = shaOf.get(tid);
        if (sha == null || !complete.remove(tid)) return;
        shaOf.remove(tid);
        new Thread(() -> {
            File part = new File(partsDir(), tid);
            boolean ok = false;
            try (InputStream in = new FileInputStream(part)) {
                MessageDigest md = MessageDigest.getInstance("SHA-256");
                byte[] buf = new byte[BUF];
                int n;
                while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
                ok = sha.equalsIgnoreCase(hex(md.digest()));
            } catch (Exception ignored) { /* counted as damaged */ }
            if (!ok) {
                part.delete();
                setState(tid, "failed", "corrupt");
                control(eid, "k", "ack", "tid", tid, "ok", "0");
                emit(obj("type", "transfer_failed", "tid", tid));
                refreshService();
                return;
            }
            JSONObject row = store.byTid(tid);
            File out = new File(dir(), System.currentTimeMillis() + "-" + (row == null ? "file" : row.optString("name", "file")));
            if (!part.renameTo(out)) {
                setState(tid, "failed", "save");
                control(eid, "k", "ack", "tid", tid, "ok", "0");
                refreshService();
                return;
            }
            ContentValues v = new ContentValues();
            v.put("state", "done");
            v.put("path", out.getAbsolutePath());
            v.put("done", out.length());
            store.update(tid, v);
            control(eid, "k", "ack", "tid", tid, "ok", "1");
            JSONObject done = store.byTid(tid);
            if (done != null) emit(item("file", done));
            refreshService();
            if (room != null && done != null) room.onReceived(done, peerDid(eid));
        }, "nearby-verify").start();
    }

    private String peerDid(String eid) {
        Peer p = peers.get(eid);
        return p == null ? "" : p.did;
    }

    // ------------------------------------------------------------------ what was received
    String items(String peer) { return store.conversation(peer).toString(); }
    String received() { return store.received().toString(); }
    String recent() { return store.peers().toString(); }
    String stats() { return store.stats().toString(); }

    /** Files that were moved by the room's web page count too. */
    NearbyStore store() { return store; }
    void itemChanged(String tid) { emitItem(tid); }

    /** A file received inside the web view moves to the app, piece by piece. */
    private final Map<String, File> imports = new ConcurrentHashMap<>();
    private final Map<String, String[]> importMeta = new ConcurrentHashMap<>();

    String importBegin(String name, String mime, String from) {
        String handle = UUID.randomUUID().toString();
        imports.put(handle, new File(partsDir(), handle));
        importMeta.put(handle, new String[]{safe(name), mime, from});
        return handle;
    }

    boolean importChunk(String handle, String base64) {
        File f = imports.get(handle);
        if (f == null) return false;
        try (FileOutputStream out = new FileOutputStream(f, true)) {
            out.write(android.util.Base64.decode(base64, android.util.Base64.DEFAULT));
            return true;
        } catch (Exception e) { return false; }
    }

    long importEnd(String handle) {
        File f = imports.remove(handle);
        String[] meta = importMeta.remove(handle);
        if (f == null || meta == null) return -1;
        File out = new File(dir(), System.currentTimeMillis() + "-" + meta[0]);
        if (!f.renameTo(out)) { f.delete(); return -1; }
        ContentValues v = new ContentValues();
        v.put("tid", handle);
        v.put("peer", "wifi");
        v.put("peer_name", meta[2]);
        v.put("dir", "in");
        v.put("kind", "file");
        v.put("name", meta[0]);
        v.put("size", out.length());
        v.put("done", out.length());
        v.put("mime", meta[1]);
        v.put("state", "done");
        v.put("path", out.getAbsolutePath());
        v.put("ts", System.currentTimeMillis());
        return store.insert(v);
    }

    /** Older versions kept the conversation in the browser's storage of the page. */
    void importOld(String json) {
        try {
            JSONArray a = new JSONArray(json);
            for (int i = 0; i < a.length(); i++) {
                JSONObject o = a.getJSONObject(i);
                ContentValues v = new ContentValues();
                v.put("tid", "old-" + o.optString("k"));
                v.put("peer", o.optString("peer"));
                v.put("peer_name", o.optString("name"));
                v.put("dir", o.optString("dir"));
                v.put("kind", o.optString("kind"));
                v.put("text", o.optString("text"));
                v.put("name", o.optString("fileName"));
                v.put("size", o.optLong("size"));
                v.put("done", o.optLong("size"));
                v.put("path", o.optString("path"));
                v.put("state", "done");
                v.put("ts", o.optLong("ts"));
                store.insert(v);
            }
        } catch (Exception ignored) { /* the old data stays where it is */ }
    }

    private File fileOf(JSONObject row) {
        try {
            if (row == null || row.isNull("path")) return null;
            File f = new File(row.optString("path"));
            if (!f.getCanonicalPath().startsWith(dir().getCanonicalPath() + File.separator) || !f.isFile()) return null;
            return f;
        } catch (IOException e) { return null; }
    }

    private String mimeOf(JSONObject row, File f) {
        String m = row.isNull("mime") ? "" : row.optString("mime");
        if (m != null && m.contains("/") && !m.equals("application/octet-stream") && !m.equals("null")) return m;
        String ext = MimeTypeMap.getFileExtensionFromUrl(Uri.fromFile(f).toString());
        String t = ext == null ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext.toLowerCase());
        return t == null ? "application/octet-stream" : t;
    }

    boolean openItem(long id) {
        Activity a = activity;
        JSONObject row = store.byId(id);
        File f = fileOf(row);
        if (a == null || f == null) return false;
        try {
            Uri uri = FileProvider.getUriForFile(app, app.getPackageName() + ".fileprovider", f);
            Intent i = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, mimeOf(row, f)).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            a.startActivity(Intent.createChooser(i, null));
            return true;
        } catch (ActivityNotFoundException e) { return false; }
    }

    boolean shareItem(long id) {
        Activity a = activity;
        JSONObject row = store.byId(id);
        File f = fileOf(row);
        if (a == null || f == null) return false;
        try {
            Uri uri = FileProvider.getUriForFile(app, app.getPackageName() + ".fileprovider", f);
            Intent i = new Intent(Intent.ACTION_SEND).setType(mimeOf(row, f)).putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            a.startActivity(Intent.createChooser(i, null));
            return true;
        } catch (ActivityNotFoundException e) { return false; }
    }

    /** Into the phone's gallery (photos, videos) or Downloads (anything else), where other apps see it. */
    void saveItem(long id) {
        JSONObject row = store.byId(id);
        File f = fileOf(row);
        if (f == null) { emit(obj("type", "saved", "id", String.valueOf(id), "ok", "0")); return; }
        new Thread(() -> {
            boolean ok = false;
            if (Build.VERSION.SDK_INT >= 29) {
                String mime = mimeOf(row, f);
                ContentResolver cr = app.getContentResolver();
                ContentValues v = new ContentValues();
                v.put(MediaStore.MediaColumns.DISPLAY_NAME, row.optString("name", "file"));
                v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                Uri base;
                if (mime.startsWith("image/")) { base = MediaStore.Images.Media.EXTERNAL_CONTENT_URI; v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/Suhbat"); }
                else if (mime.startsWith("video/")) { base = MediaStore.Video.Media.EXTERNAL_CONTENT_URI; v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_MOVIES + "/Suhbat"); }
                else { base = MediaStore.Downloads.EXTERNAL_CONTENT_URI; v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Suhbat"); }
                Uri target = cr.insert(base, v);
                if (target != null) {
                    try (InputStream in = new FileInputStream(f); OutputStream out = cr.openOutputStream(target)) {
                        if (out == null) throw new IOException("no target");
                        byte[] buf = new byte[BUF];
                        int n;
                        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                        ok = true;
                    } catch (Exception e) {
                        cr.delete(target, null, null);
                    }
                }
            }
            if (ok) {
                ContentValues u = new ContentValues();
                u.put("gallery", 1);
                store.update(row.optString("tid"), u);
            }
            emit(obj("type", "saved", "id", String.valueOf(id), "ok", ok ? "1" : "0"));
        }, "nearby-save").start();
    }

    void deleteItem(long id) {
        JSONObject row = store.byId(id);
        File f = fileOf(row);
        if (f != null) //noinspection ResultOfMethodCallIgnored
            f.delete();
        store.delete(id);
    }

    /** The web view asks for /__nb/item/<id> or /__nb/shared/<i>: previews and hand-over to a chat, with ranges for video. */
    WebResourceResponse intercept(Uri url, Map<String, String> headers) {
        List<String> seg = url.getPathSegments();
        if (seg.size() != 3) return notFound();
        try {
            long n = Long.parseLong(seg.get(2));
            if ("item".equals(seg.get(1))) {
                JSONObject row = store.byId(n);
                File f = fileOf(row);
                if (f == null) return notFound();
                return ranged(new FileInputStream(f), f.length(), mimeOf(row, f), headers);
            }
            if ("shared".equals(seg.get(1)) && n >= 0 && n < shared.size()) {
                Uri u = shared.get((int) n);
                InputStream in = app.getContentResolver().openInputStream(u);
                if (in == null) return notFound();
                String m = app.getContentResolver().getType(u);
                return ranged(in, sizeOf(u), m == null ? "application/octet-stream" : m, headers);
            }
        } catch (Exception ignored) { /* not found */ }
        return notFound();
    }

    private static WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", new HashMap<>(), new java.io.ByteArrayInputStream(new byte[0]));
    }

    private static WebResourceResponse ranged(InputStream in, long size, String mime, Map<String, String> req) throws IOException {
        Map<String, String> h = new HashMap<>();
        h.put("Cache-Control", "no-store");
        h.put("X-Content-Type-Options", "nosniff");
        if (mime.contains("html") || mime.contains("svg") || mime.contains("xml")) mime = "application/octet-stream"; // never as a page of our origin
        String range = null;
        if (req != null) for (Map.Entry<String, String> e : req.entrySet()) if ("range".equalsIgnoreCase(e.getKey())) range = e.getValue();
        h.put("Accept-Ranges", "bytes");
        java.util.regex.Matcher m = range == null || size <= 0 ? null : java.util.regex.Pattern.compile("bytes=(\\d+)-(\\d*)").matcher(range);
        if (m != null && m.matches()) {
            long from = Long.parseLong(m.group(1));
            long to = m.group(2).isEmpty() ? size - 1 : Math.min(size - 1, Long.parseLong(m.group(2)));
            if (from > to) { in.close(); return notFound(); }
            long left = from;
            while (left > 0) {
                long s = in.skip(left);
                if (s <= 0) break;
                left -= s;
            }
            h.put("Content-Range", "bytes " + from + "-" + to + "/" + size);
            h.put("Content-Length", String.valueOf(to - from + 1));
            return new WebResourceResponse(mime, null, 206, "Partial Content", h, new Limited(in, to - from + 1));
        }
        if (size > 0) h.put("Content-Length", String.valueOf(size));
        return new WebResourceResponse(mime, null, 200, "OK", h, in);
    }

    private static final class Limited extends java.io.FilterInputStream {
        private long left;
        Limited(InputStream in, long n) { super(in); left = n; }
        @Override public int read() throws IOException { if (left <= 0) return -1; int b = super.read(); if (b >= 0) left--; return b; }
        @Override public int read(@NonNull byte[] b, int off, int len) throws IOException {
            if (left <= 0) return -1;
            int n = super.read(b, off, (int) Math.min(len, left));
            if (n > 0) left -= n;
            return n;
        }
    }

    // ------------------------------------------------------------------ a room: one phone hands files to everybody around
    void roomStart(String name, String endpointName) {
        if (room == null) room = new LocalShare(app, this);
        if (!hasPermissions()) { askPermissions(); return; }
        roomName = name;
        room.start(name);
        if (supported()) {
            client = Nearby.getConnectionsClient(app);
            myName = endpointName;
            stopFindingQuietly();
            advertise();
        }
        refreshService();
    }

    void roomStop() {
        roomName = null;
        if (room != null) room.stop();
        room = null;
        if (client != null) {
            try { client.stopAdvertising(); } catch (Throwable ignored) { /* not running */ }
            advertising = false;
            for (Peer p : new ArrayList<>(peers.values())) if (p.roomGuest) disconnect(p.id);
        }
        refreshService();
    }

    String roomInfo() {
        return room == null ? "{\"on\":false}" : room.info();
    }

    /** A file of the room goes to every phone connected to the room, except the one it came from. */
    void roomRelay(String uri, String path, String name, long size, String mime, String exceptDid) {
        for (Peer p : peers.values()) {
            if (p.connected && p.roomGuest && !p.did.equals(exceptDid)) enqueue(p.did, uri, path, name, size, mime, 0);
        }
    }

    void pickForRoom() {
        pickFiles("[\"room\"]", 0);
    }

    // ------------------------------------------------------------------ events to the page
    private void setState(String tid, String state, String reason) {
        ContentValues v = new ContentValues();
        v.put("state", state);
        if (reason != null) v.put("reason", reason);
        store.update(tid, v);
        emitItem(tid);
    }

    private void emitItem(String tid) {
        JSONObject row = store.byTid(tid);
        if (row != null) emit(item("item", row));
    }

    private static JSONObject item(String type, JSONObject row) {
        try { row.put("type", type); } catch (Exception ignored) { /* keys are fixed */ }
        return row;
    }

    /** Progress reaches the page and the notification a few times a second at most. */
    private void report(String tid, long bytes, long total) {
        long now = System.currentTimeMillis();
        long[] prev = speed.get(tid);
        if (prev != null && now - prev[1] < 300) return;
        long bps = prev == null || now == prev[1] ? 0 : (bytes - prev[0]) * 1000 / (now - prev[1]);
        speed.put(tid, new long[]{bytes, now});
        ContentValues v = new ContentValues();
        v.put("done", bytes);
        store.update(tid, v);
        emit(obj("type", "progress", "tid", tid, "done", String.valueOf(bytes), "size", String.valueOf(total), "bps", String.valueOf(Math.max(0, bps))));
        int pct = total > 0 ? (int) Math.min(100, bytes * 100 / total) : -1;
        NearbyService.show(app, "Передача файла", pct);
    }

    private void refreshService() {
        boolean moving = false;
        for (JSONObject o : list(store.unfinished())) {
            String s = o.optString("state");
            if ("active".equals(s) || "offered".equals(s) || "verifying".equals(s)) moving = true;
        }
        if (moving) NearbyService.show(app, "Передача файла", -1);
        else if (roomName != null) NearbyService.show(app, "Открыта комната: " + roomName, -1);
        else NearbyService.hide(app);
    }

    void onRoomChanged() {
        emit(obj("type", "room"));
    }

    private void fail(String what, Exception e) {
        String code = "";
        if (e instanceof com.google.android.gms.common.api.ApiException) code = String.valueOf(((com.google.android.gms.common.api.ApiException) e).getStatusCode());
        if ("advertise".equals(what)) advertising = false;
        if ("discover".equals(what)) discovering = false;
        emit(obj("type", "error", "where", what, "code", code, "message", String.valueOf(e.getMessage())));
    }

    private static JSONObject obj(String... kv) {
        JSONObject o = new JSONObject();
        try { for (int i = 0; i + 1 < kv.length; i += 2) o.put(kv[i], kv[i + 1]); } catch (Exception ignored) { /* keys are fixed */ }
        return o;
    }

    void emit(JSONObject o) {
        final WebView w = web;
        if (w == null) return;
        final String js = "window.__nearby&&window.__nearby(JSON.parse(" + JSONObject.quote(o.toString()) + "))";
        main.post(() -> w.evaluateJavascript(js, null));
    }
}
