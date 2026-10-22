package app.suhbat.mobile;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.ParcelFileDescriptor;
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

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/**
 * Messaging without internet between phones that are near each other (Google Nearby Connections: Bluetooth + Wi-Fi Direct).
 * This class only moves bytes and files and reports events to the page (window.__nearby); the protocol lives in nearby.js.
 */
class NearbyBridge {
    static final int REQ_PICK = 7001;
    static final int REQ_PERM = 7002;
    private static final String SERVICE_ID = "app.suhbat.nearby";
    private static final int MAX_BYTES = 30000; // Nearby allows 32 KB for a bytes payload

    private final Activity activity;
    private final WebView web;
    private ConnectionsClient client;
    private boolean running = false;
    private String myName = "";
    private String pickTarget = null;

    // received files: payloadId -> file name from the metadata message; completed payloads wait for their name
    private final Map<Long, String> names = new HashMap<>();
    private final Map<Long, Payload> files = new HashMap<>();
    private final Map<Long, String> fileFrom = new HashMap<>();
    private final Map<Long, Long> fileSize = new HashMap<>();
    private final Map<Long, Boolean> doneFiles = new HashMap<>();
    private final Map<String, String> endpointNames = new HashMap<>();

    NearbyBridge(Activity activity, WebView web) {
        this.activity = activity;
        this.web = web;
    }

    // ------------------------------------------------------------------ availability and permissions
    boolean supported() {
        try {
            return GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(activity) == ConnectionResult.SUCCESS;
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

    private boolean hasPermissions() {
        for (String p : needed()) if (ContextCompat.checkSelfPermission(activity, p) != PackageManager.PERMISSION_GRANTED) return false;
        return true;
    }

    /** "ok" when it started, "permissions" when the system dialog was shown (the page asks again after "perm" event). */
    String start(String name) {
        if (!supported()) return "unsupported";
        myName = (name == null || name.isEmpty()) ? "Suhbat" : name;
        if (!hasPermissions()) {
            ActivityCompat.requestPermissions(activity, needed(), REQ_PERM);
            return "permissions";
        }
        if (running) return "ok";
        client = Nearby.getConnectionsClient(activity);
        running = true;
        client.startAdvertising(myName, SERVICE_ID, lifecycle,
                new AdvertisingOptions.Builder().setStrategy(Strategy.P2P_CLUSTER).build())
                .addOnFailureListener(e -> fail("advertise", e));
        client.startDiscovery(SERVICE_ID, discovery,
                new DiscoveryOptions.Builder().setStrategy(Strategy.P2P_CLUSTER).build())
                .addOnFailureListener(e -> fail("discover", e));
        emit(obj("type", "started"));
        return "ok";
    }

    void onPermissionResult(int[] results) {
        boolean all = results.length > 0;
        for (int r : results) if (r != PackageManager.PERMISSION_GRANTED) all = false;
        emit(obj("type", "perm", "granted", all ? "1" : "0"));
    }

    /** Stop being visible and searching; the connections that exist stay (a conversation goes on). */
    void stopFinding() {
        if (client == null) return;
        try { client.stopAdvertising(); } catch (Throwable ignored) { /* not running */ }
        try { client.stopDiscovery(); } catch (Throwable ignored) { /* not running */ }
        running = false;
        emit(obj("type", "stopped"));
    }

    void stopAll() {
        stopFinding();
        if (client != null) { try { client.stopAllEndpoints(); } catch (Throwable ignored) { /* none */ } }
    }

    // ------------------------------------------------------------------ connections
    private final EndpointDiscoveryCallback discovery = new EndpointDiscoveryCallback() {
        @Override public void onEndpointFound(@NonNull String id, @NonNull DiscoveredEndpointInfo info) {
            endpointNames.put(id, info.getEndpointName());
            emit(obj("type", "found", "id", id, "name", info.getEndpointName()));
        }
        @Override public void onEndpointLost(@NonNull String id) {
            emit(obj("type", "lost", "id", id));
        }
    };

    private final ConnectionLifecycleCallback lifecycle = new ConnectionLifecycleCallback() {
        @Override public void onConnectionInitiated(@NonNull String id, @NonNull ConnectionInfo info) {
            endpointNames.put(id, info.getEndpointName());
            // both phones show the same 4 digits: the people compare them (protection against someone in the middle)
            emit(obj("type", "request", "id", id, "name", info.getEndpointName(), "code", info.getAuthenticationDigits(),
                    "incoming", info.isIncomingConnection() ? "1" : "0"));
        }
        @Override public void onConnectionResult(@NonNull String id, @NonNull ConnectionResolution r) {
            int code = r.getStatus().getStatusCode();
            if (code == ConnectionsStatusCodes.STATUS_OK) emit(obj("type", "connected", "id", id, "name", endpointNames.get(id)));
            else emit(obj("type", "refused", "id", id, "code", String.valueOf(code)));
        }
        @Override public void onDisconnected(@NonNull String id) {
            emit(obj("type", "disconnected", "id", id));
        }
    };

    void connect(String id) {
        if (client == null) return;
        client.requestConnection(myName, id, lifecycle).addOnFailureListener(e -> fail("connect", e));
    }

    void accept(String id) {
        if (client != null) client.acceptConnection(id, payloads).addOnFailureListener(e -> fail("accept", e));
    }

    void reject(String id) {
        if (client != null) client.rejectConnection(id);
    }

    void disconnect(String id) {
        if (client != null) client.disconnectFromEndpoint(id);
    }

    // ------------------------------------------------------------------ sending
    boolean sendBytes(String id, String text) {
        if (client == null || text == null) return false;
        byte[] data = text.getBytes(StandardCharsets.UTF_8);
        if (data.length > MAX_BYTES) return false;
        client.sendPayload(id, Payload.fromBytes(data)).addOnFailureListener(e -> fail("send", e));
        return true;
    }

    void pickFile(String id) {
        pickTarget = id;
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("*/*");
        activity.startActivityForResult(i, REQ_PICK);
    }

    void onFilePicked(int resultCode, Intent data) {
        final String id = pickTarget;
        pickTarget = null;
        if (resultCode != Activity.RESULT_OK || data == null || data.getData() == null || id == null || client == null) return;
        try {
            Uri uri = data.getData();
            ParcelFileDescriptor pfd = activity.getContentResolver().openFileDescriptor(uri, "r");
            if (pfd == null) return;
            String name = displayName(uri);
            long size = pfd.getStatSize();
            Payload p = Payload.fromFile(pfd);
            // the description first, then the file itself (the receiver pairs them by the payload id)
            JSONObject meta = new JSONObject();
            meta.put("k", "file");
            meta.put("pid", p.getId());
            meta.put("name", name);
            meta.put("size", size);
            client.sendPayload(id, Payload.fromBytes(meta.toString().getBytes(StandardCharsets.UTF_8)));
            client.sendPayload(id, p).addOnFailureListener(e -> fail("send", e));
            emit(obj("type", "sending", "id", id, "pid", String.valueOf(p.getId()), "name", name, "size", String.valueOf(size)));
        } catch (Exception e) {
            fail("pick", e);
        }
    }

    private String displayName(Uri uri) {
        try (android.database.Cursor c = activity.getContentResolver().query(uri, null, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int ix = c.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME);
                if (ix >= 0 && c.getString(ix) != null) return c.getString(ix);
            }
        } catch (Exception ignored) { /* fall through */ }
        String last = uri.getLastPathSegment();
        return last == null ? "file" : last;
    }

    // ------------------------------------------------------------------ receiving
    private final PayloadCallback payloads = new PayloadCallback() {
        @Override public void onPayloadReceived(@NonNull String id, @NonNull Payload p) {
            if (p.getType() == Payload.Type.BYTES && p.asBytes() != null) {
                String s = new String(p.asBytes(), StandardCharsets.UTF_8);
                try {
                    JSONObject j = new JSONObject(s);
                    if ("file".equals(j.optString("k")) && j.has("pid")) {
                        long pid = j.getLong("pid");
                        names.put(pid, safe(j.optString("name", "file")));
                        fileSize.put(pid, j.optLong("size", 0));
                        finishFile(pid);
                        return;
                    }
                } catch (Exception ignored) { /* an ordinary text message: the page parses it */ }
                emit(obj("type", "bytes", "id", id, "data", s));
            } else if (p.getType() == Payload.Type.FILE) {
                files.put(p.getId(), p);
                fileFrom.put(p.getId(), id);
            }
        }

        @Override public void onPayloadTransferUpdate(@NonNull String id, @NonNull PayloadTransferUpdate u) {
            long pid = u.getPayloadId();
            if (u.getStatus() == PayloadTransferUpdate.Status.IN_PROGRESS && u.getTotalBytes() > 0) {
                emit(obj("type", "progress", "id", id, "pid", String.valueOf(pid), "pct", String.valueOf((int) (u.getBytesTransferred() * 100 / u.getTotalBytes()))));
            } else if (u.getStatus() == PayloadTransferUpdate.Status.SUCCESS) {
                if (files.containsKey(pid)) { doneFiles.put(pid, true); finishFile(pid); }
                else emit(obj("type", "sent", "id", id, "pid", String.valueOf(pid)));
            } else if (u.getStatus() == PayloadTransferUpdate.Status.FAILURE || u.getStatus() == PayloadTransferUpdate.Status.CANCELED) {
                emit(obj("type", "transfer_failed", "id", id, "pid", String.valueOf(pid)));
            }
        }
    };

    private static String safe(String n) {
        String s = n == null ? "file" : n.replaceAll("[\\\\/:*?\"<>|]", "_").trim();
        return s.isEmpty() ? "file" : (s.length() > 120 ? s.substring(s.length() - 120) : s);
    }

    /** Copy a finished incoming file next to the app's data (the system's own copy may disappear). */
    private void finishFile(long pid) {
        Payload p = files.get(pid);
        String name = names.get(pid);
        if (p == null || name == null || !Boolean.TRUE.equals(doneFiles.get(pid))) return;
        files.remove(pid);
        doneFiles.remove(pid);
        final String from = fileFrom.remove(pid);
        final Long size = fileSize.remove(pid);
        names.remove(pid);
        new Thread(() -> {
            try {
                File dir = new File(activity.getFilesDir(), "nearby");
                //noinspection ResultOfMethodCallIgnored
                dir.mkdirs();
                File out = new File(dir, System.currentTimeMillis() + "-" + name);
                InputStream in;
                Payload.File pf = p.asFile();
                if (pf == null) return;
                if (Build.VERSION.SDK_INT >= 29 && pf.asUri() != null) in = activity.getContentResolver().openInputStream(pf.asUri());
                else in = new java.io.FileInputStream(pf.asJavaFile());
                if (in == null) return;
                try (InputStream src = in; FileOutputStream dst = new FileOutputStream(out)) {
                    byte[] buf = new byte[65536];
                    int n;
                    while ((n = src.read(buf)) > 0) dst.write(buf, 0, n);
                }
                emit(obj("type", "file", "id", from, "name", name, "size", String.valueOf(size == null ? out.length() : size), "path", out.getAbsolutePath()));
            } catch (Exception e) {
                fail("save", e);
            }
        }).start();
    }

    boolean openReceived(String path) {
        try {
            File f = new File(path);
            File root = new File(activity.getFilesDir(), "nearby");
            if (!f.getCanonicalPath().startsWith(root.getCanonicalPath() + File.separator) || !f.isFile()) return false;
            String ext = android.webkit.MimeTypeMap.getFileExtensionFromUrl(Uri.fromFile(f).toString());
            String type = ext != null ? android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext.toLowerCase()) : null;
            Uri uri = FileProvider.getUriForFile(activity, activity.getPackageName() + ".fileprovider", f);
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(uri, type == null ? "*/*" : type);
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            activity.startActivity(Intent.createChooser(i, null));
            return true;
        } catch (ActivityNotFoundException e) {
            return false;
        } catch (Exception e) {
            return false;
        }
    }

    // ------------------------------------------------------------------ events to the page
    private void fail(String what, Exception e) {
        String code = "";
        if (e instanceof com.google.android.gms.common.api.ApiException) code = String.valueOf(((com.google.android.gms.common.api.ApiException) e).getStatusCode());
        if ("advertise".equals(what) || "discover".equals(what)) running = false;
        emit(obj("type", "error", "where", what, "code", code, "message", String.valueOf(e.getMessage())));
    }

    private static JSONObject obj(String... kv) {
        JSONObject o = new JSONObject();
        try { for (int i = 0; i + 1 < kv.length; i += 2) o.put(kv[i], kv[i + 1]); } catch (Exception ignored) { /* keys are fixed */ }
        return o;
    }

    private void emit(JSONObject o) {
        final String js = "window.__nearby&&window.__nearby(JSON.parse(" + JSONObject.quote(o.toString()) + "))";
        web.post(() -> web.evaluateJavascript(js, null));
    }
}
