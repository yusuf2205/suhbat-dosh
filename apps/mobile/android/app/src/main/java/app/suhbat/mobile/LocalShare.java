package app.suhbat.mobile;

import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.net.wifi.SoftApConfiguration;
import android.net.wifi.WifiConfiguration;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * A room: this phone raises its own Wi-Fi and serves a small page, so anybody around can take and add files with only a
 * browser: an iPhone, a computer, a phone without our app or without Google services. No internet is involved.
 * The address carries a random token; the network itself has a password.
 */
final class LocalShare {
    private static final int BUF = 256 * 1024;

    private static final class Shared {
        final int id;
        final String name, mime, uri, path, from;
        final long size;
        Shared(int id, String name, long size, String mime, String uri, String path, String from) {
            this.id = id; this.name = name; this.size = size; this.mime = mime == null ? "" : mime; this.uri = uri; this.path = path; this.from = from;
        }
    }

    private final Context app;
    private final NearbyBridge bridge;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final List<Shared> files = new CopyOnWriteArrayList<>();
    private final Set<String> guests = ConcurrentHashMap.newKeySet();
    private final Set<String> phones = ConcurrentHashMap.newKeySet();
    private int nextId = 1;
    private String name = "";
    private String token = "";
    private ServerSocket server;
    private volatile boolean on = false;
    private WifiManager.LocalOnlyHotspotReservation reservation;
    private String ssid, pass, hotspotError;

    LocalShare(Context c, NearbyBridge b) {
        app = c;
        bridge = b;
    }

    void start(String roomName) {
        if (on) return;
        name = roomName;
        byte[] r = new byte[12];
        new SecureRandom().nextBytes(r);
        StringBuilder sb = new StringBuilder();
        for (byte x : r) sb.append(String.format("%02x", x));
        token = sb.toString();
        on = true;
        try {
            server = new ServerSocket(0, 50);
            Thread t = new Thread(this::accept, "room-http");
            t.setDaemon(true);
            t.start();
        } catch (IOException e) {
            hotspotError = "server";
            on = false;
        }
        startHotspot();
        bridge.onRoomChanged();
    }

    private void startHotspot() {
        if (Build.VERSION.SDK_INT < 26) { hotspotError = "android"; return; }
        try {
            WifiManager wm = (WifiManager) app.getSystemService(Context.WIFI_SERVICE);
            wm.startLocalOnlyHotspot(new WifiManager.LocalOnlyHotspotCallback() {
                @Override public void onStarted(WifiManager.LocalOnlyHotspotReservation res) {
                    reservation = res;
                    readCredentials(res);
                    hotspotError = null;
                    // the interface gets its address a moment later
                    main.postDelayed(bridge::onRoomChanged, 800);
                }
                @Override public void onFailed(int reason) {
                    hotspotError = String.valueOf(reason);
                    bridge.onRoomChanged();
                }
                @Override public void onStopped() {
                    reservation = null;
                    ssid = null;
                    pass = null;
                    bridge.onRoomChanged();
                }
            }, main);
        } catch (Exception e) {
            hotspotError = e.getClass().getSimpleName();
        }
    }

    @SuppressWarnings("deprecation")
    private void readCredentials(WifiManager.LocalOnlyHotspotReservation res) {
        if (Build.VERSION.SDK_INT >= 30) {
            SoftApConfiguration c = res.getSoftApConfiguration();
            ssid = c.getSsid();
            pass = c.getPassphrase();
        } else {
            WifiConfiguration c = res.getWifiConfiguration();
            if (c != null) { ssid = c.SSID; pass = c.preSharedKey; }
        }
    }

    void stop() {
        on = false;
        try { if (server != null) server.close(); } catch (IOException ignored) { /* closed */ }
        server = null;
        try { if (reservation != null) reservation.close(); } catch (Exception ignored) { /* closed */ }
        reservation = null;
        files.clear();
        guests.clear();
        phones.clear();
    }

    /** The address of this phone that the others can reach: the room's own network first. */
    private String address() {
        String wifiClient = null;
        try {
            for (NetworkInterface n : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!n.isUp() || n.isLoopback()) continue;
                String nm = n.getName().toLowerCase(Locale.ROOT);
                if (nm.startsWith("rmnet") || nm.startsWith("ccmni") || nm.startsWith("tun") || nm.startsWith("dummy")) continue;
                for (InetAddress a : Collections.list(n.getInetAddresses())) {
                    if (!(a instanceof Inet4Address) || !a.isSiteLocalAddress()) continue;
                    if (nm.equals("wlan0")) { wifiClient = a.getHostAddress(); if (reservation == null) return wifiClient; continue; }
                    return a.getHostAddress();
                }
            }
        } catch (Exception ignored) { /* none */ }
        return wifiClient;
    }

    String info() {
        JSONObject o = new JSONObject();
        try {
            o.put("on", on);
            o.put("name", name);
            String ip = address();
            if (ip != null && server != null) o.put("url", "http://" + ip + ":" + server.getLocalPort() + "/t/" + token + "/");
            if (ssid != null) {
                o.put("ssid", ssid);
                o.put("pass", pass);
                o.put("wifi_qr", "WIFI:T:WPA;S:" + esc(ssid) + ";P:" + esc(pass == null ? "" : pass) + ";;");
            }
            if (hotspotError != null) o.put("hotspot_error", hotspotError);
            o.put("guests", guests.size() + phones.size());
            JSONArray a = new JSONArray();
            for (Shared s : files) a.put(new JSONObject().put("id", s.id).put("name", s.name).put("size", s.size).put("mime", s.mime).put("from", s.from));
            o.put("files", a);
        } catch (Exception ignored) { /* what was built */ }
        return o.toString();
    }

    private static String esc(String s) {
        return s.replaceAll("([\\\\;,:\"])", "\\\\$1");
    }

    // ------------------------------------------------------------------ the list
    private synchronized int id() {
        return nextId++;
    }

    void addUri(Uri u, String fileName, long size, String mime) {
        files.add(new Shared(id(), fileName, size, mime, u.toString(), null, "host"));
        bridge.roomRelay(u.toString(), null, fileName, size, mime, "");
        bridge.onRoomChanged();
    }

    /** A file that came from a phone of the room goes to the list and on to the other phones. */
    void onReceived(JSONObject row, String fromDid) {
        String path = row.optString("path");
        files.add(new Shared(id(), row.optString("name"), row.optLong("size"), row.isNull("mime") ? "" : row.optString("mime"), null, path, row.optString("peer_name")));
        bridge.roomRelay(null, path, row.optString("name"), row.optLong("size"), row.isNull("mime") ? "" : row.optString("mime"), fromDid);
        bridge.onRoomChanged();
    }

    /** A phone that joins late gets everything shared so far. */
    void onGuestJoined(String did) {
        phones.add(did);
        for (Shared s : files) bridge.enqueue(did, s.uri, s.path, s.name, s.size, s.mime, 0);
        bridge.onRoomChanged();
    }

    // ------------------------------------------------------------------ a very small web server
    private void accept() {
        ServerSocket ss = server;
        while (on && ss != null && !ss.isClosed()) {
            try {
                Socket s = ss.accept();
                Thread t = new Thread(() -> serve(s), "room-conn");
                t.setDaemon(true);
                t.start();
            } catch (IOException e) {
                return;
            }
        }
    }

    private void serve(Socket s) {
        try (Socket sock = s) {
            sock.setSoTimeout(60_000);
            InputStream in = sock.getInputStream();
            OutputStream out = new BufferedOutputStream(sock.getOutputStream(), 64 * 1024);
            String head = readHead(in);
            if (head == null) return;
            String[] lines = head.split("\r\n");
            String[] first = lines[0].split(" ");
            if (first.length < 2) return;
            Map<String, String> h = new HashMap<>();
            for (int i = 1; i < lines.length; i++) {
                int c = lines[i].indexOf(':');
                if (c > 0) h.put(lines[i].substring(0, c).trim().toLowerCase(Locale.ROOT), lines[i].substring(c + 1).trim());
            }
            guests.add(String.valueOf(sock.getInetAddress()));
            route(first[0], first[1], h, in, out);
            out.flush();
        } catch (Exception ignored) { /* the guest went away */ }
    }

    private static String readHead(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        int c, state = 0;
        while ((c = in.read()) >= 0) {
            b.write(c);
            if (b.size() > 16 * 1024) return null;
            state = (c == '\r' && (state == 0 || state == 2)) ? state + 1 : (c == '\n' && (state == 1 || state == 3)) ? state + 1 : 0;
            if (state == 4) return new String(b.toByteArray(), 0, b.size() - 4, StandardCharsets.ISO_8859_1);
        }
        return null;
    }

    private void route(String method, String target, Map<String, String> h, InputStream in, OutputStream out) throws Exception {
        int q = target.indexOf('?');
        String path = q >= 0 ? target.substring(0, q) : target;
        String query = q >= 0 ? target.substring(q + 1) : "";
        String prefix = "/t/" + token + "/";
        if (!path.startsWith(prefix)) { text(out, 404, "text/plain; charset=utf-8", "Scan the QR code of the room / QR kodni skanerlang"); return; }
        String rest = path.substring(prefix.length());
        boolean head = "HEAD".equals(method);
        if (rest.isEmpty() && (head || "GET".equals(method))) { page(out); return; }
        if (rest.equals("files") && "GET".equals(method)) { text(out, 200, "application/json; charset=utf-8", listJson()); return; }
        if (rest.equals("app.apk") && (head || "GET".equals(method))) {
            File apk = new File(app.getPackageCodePath());
            send(out, new FileInputStream(apk), apk.length(), "application/vnd.android.package-archive", "Suhbat-dosh.apk", true, h, head);
            return;
        }
        if (rest.startsWith("f/") && (head || "GET".equals(method))) {
            Shared f = byId(rest.substring(2));
            if (f == null) { text(out, 404, "text/plain", "gone"); return; }
            InputStream src = f.path != null ? new FileInputStream(f.path) : app.getContentResolver().openInputStream(Uri.parse(f.uri));
            if (src == null) { text(out, 404, "text/plain", "gone"); return; }
            send(out, src, f.size, f.mime, f.name, query.contains("dl=1"), h, head);
            return;
        }
        if (rest.equals("u") && "PUT".equals(method)) { upload(query, h, in, out); return; }
        text(out, 404, "text/plain", "not found");
    }

    private Shared byId(String s) {
        try {
            int id = Integer.parseInt(s);
            for (Shared f : files) if (f.id == id) return f;
        } catch (NumberFormatException ignored) { /* none */ }
        return null;
    }

    private String listJson() throws Exception {
        JSONObject o = new JSONObject().put("name", name);
        JSONArray a = new JSONArray();
        for (Shared s : files) a.put(new JSONObject().put("id", s.id).put("name", s.name).put("size", s.size).put("mime", s.mime));
        return o.put("files", a).toString();
    }

    private void page(OutputStream out) throws IOException {
        try (InputStream in = app.getAssets().open("room.html")) {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            byte[] buf = new byte[16 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) b.write(buf, 0, n);
            text(out, 200, "text/html; charset=utf-8", b.toString("UTF-8"));
        }
    }

    private static void text(OutputStream out, int code, String type, String body) throws IOException {
        byte[] b = body.getBytes(StandardCharsets.UTF_8);
        head(out, code, type, b.length, null);
        out.write(b);
    }

    private static void head(OutputStream out, int code, String type, long length, Map<String, String> extra) throws IOException {
        StringBuilder sb = new StringBuilder("HTTP/1.1 ").append(code).append(code == 200 ? " OK" : code == 206 ? " Partial Content" : code == 404 ? " Not Found" : " Error").append("\r\n");
        sb.append("Content-Type: ").append(type).append("\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n");
        if (length >= 0) sb.append("Content-Length: ").append(length).append("\r\n");
        if (extra != null) for (Map.Entry<String, String> e : extra.entrySet()) sb.append(e.getKey()).append(": ").append(e.getValue()).append("\r\n");
        out.write(sb.append("\r\n").toString().getBytes(StandardCharsets.ISO_8859_1));
    }

    private static boolean previewable(String mime) {
        return mime.startsWith("image/") && !mime.contains("svg") || mime.startsWith("video/") || mime.startsWith("audio/");
    }

    private static void send(OutputStream out, InputStream in, long size, String mime, String fileName, boolean download, Map<String, String> h, boolean headOnly) throws IOException {
        try (InputStream src = in) {
            boolean inline = !download && previewable(mime);
            Map<String, String> extra = new HashMap<>();
            extra.put("Accept-Ranges", "bytes");
            extra.put("Content-Disposition", (inline ? "inline" : "attachment") + "; filename*=UTF-8''" + URLEncoder.encode(fileName, "UTF-8").replace("+", "%20"));
            String type = inline || download && mime.contains("android.package") ? mime : "application/octet-stream";
            long from = 0, to = size - 1;
            int code = 200;
            String range = h.get("range");
            if (range != null && size > 0) {
                java.util.regex.Matcher m = java.util.regex.Pattern.compile("bytes=(\\d+)-(\\d*)").matcher(range);
                if (m.matches()) {
                    from = Long.parseLong(m.group(1));
                    if (!m.group(2).isEmpty()) to = Math.min(to, Long.parseLong(m.group(2)));
                    if (from > to) { text(out, 404, "text/plain", "range"); return; }
                    code = 206;
                    extra.put("Content-Range", "bytes " + from + "-" + to + "/" + size);
                }
            }
            head(out, code, type, size > 0 ? to - from + 1 : -1, extra);
            if (headOnly) return;
            long left = from;
            while (left > 0) {
                long s = src.skip(left);
                if (s <= 0) return;
                left -= s;
            }
            long remaining = to - from + 1;
            byte[] buf = new byte[BUF];
            int n;
            while ((size <= 0 || remaining > 0) && (n = src.read(buf, 0, size <= 0 ? buf.length : (int) Math.min(buf.length, remaining))) > 0) {
                out.write(buf, 0, n);
                remaining -= n;
            }
        }
    }

    /** A guest adds a file: it is written next to the other received ones and goes on the list. */
    private void upload(String query, Map<String, String> h, InputStream in, OutputStream out) throws Exception {
        long length;
        try { length = Long.parseLong(String.valueOf(h.get("content-length"))); } catch (NumberFormatException e) { text(out, 400, "text/plain", "length"); return; }
        String fileName = "file";
        String mime = h.getOrDefault("content-type", "");
        for (String p : query.split("&")) if (p.startsWith("name=")) fileName = URLDecoder.decode(p.substring(5), "UTF-8");
        fileName = fileName.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        if (fileName.isEmpty() || fileName.startsWith(".")) fileName = "file";
        if (fileName.length() > 120) fileName = fileName.substring(fileName.length() - 120);
        File dir = new File(app.getFilesDir(), "nearby");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        if (dir.getUsableSpace() < length + 16 * 1024 * 1024) { text(out, 507, "text/plain", "no space"); return; }
        File part = new File(dir, ".up-" + UUID.randomUUID());
        File done = new File(dir, System.currentTimeMillis() + "-" + fileName);
        try (FileOutputStream dst = new FileOutputStream(part)) {
            byte[] buf = new byte[BUF];
            long left = length;
            int n;
            while (left > 0 && (n = in.read(buf, 0, (int) Math.min(buf.length, left))) > 0) {
                dst.write(buf, 0, n);
                left -= n;
            }
            if (left > 0) throw new IOException("short");
        } catch (IOException e) {
            //noinspection ResultOfMethodCallIgnored
            part.delete();
            throw e;
        }
        if (!part.renameTo(done)) { text(out, 500, "text/plain", "save"); return; }
        String tid = UUID.randomUUID().toString();
        ContentValues v = new ContentValues();
        v.put("tid", tid);
        v.put("peer", "room-guest");
        v.put("peer_name", "Wi-Fi");
        v.put("dir", "in");
        v.put("kind", "file");
        v.put("name", fileName);
        v.put("size", length);
        v.put("done", length);
        v.put("mime", mime);
        v.put("state", "done");
        v.put("path", done.getAbsolutePath());
        v.put("ts", System.currentTimeMillis());
        v.put("room", 1);
        bridge.store().insert(v);
        files.add(new Shared(id(), fileName, length, mime, null, done.getAbsolutePath(), "guest"));
        bridge.roomRelay(null, done.getAbsolutePath(), fileName, length, mime, "");
        bridge.itemChanged(tid);
        bridge.onRoomChanged();
        text(out, 200, "application/json", "{\"ok\":true}");
    }
}
