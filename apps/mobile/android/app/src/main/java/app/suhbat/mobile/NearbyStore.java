package app.suhbat.mobile;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * What was sent and received directly, on this phone only. It lives outside the web view, so the same list is seen
 * from the messenger and from the offline page (they have different origins and so different browser storage).
 */
final class NearbyStore extends SQLiteOpenHelper {
    private static final String[] TEXT_COLS = {"tid", "peer", "peer_name", "dir", "kind", "text", "name", "mime", "state", "path", "uri", "reason"};
    private static final String[] NUM_COLS = {"id", "size", "done", "ts", "room", "chat_id", "gallery", "seen"};

    NearbyStore(Context c) {
        super(c.getApplicationContext(), "nearby.db", null, 1);
    }

    @Override
    public void onCreate(SQLiteDatabase d) {
        d.execSQL("CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, tid TEXT UNIQUE, peer TEXT NOT NULL, peer_name TEXT,"
                + " dir TEXT NOT NULL, kind TEXT NOT NULL, text TEXT, name TEXT, size INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0,"
                + " mime TEXT, state TEXT NOT NULL DEFAULT 'done', path TEXT, uri TEXT, reason TEXT, ts INTEGER NOT NULL, room INTEGER NOT NULL DEFAULT 0,"
                + " chat_id INTEGER NOT NULL DEFAULT 0, gallery INTEGER NOT NULL DEFAULT 0, seen INTEGER NOT NULL DEFAULT 0)");
        d.execSQL("CREATE INDEX items_peer ON items(peer, ts)");
        d.execSQL("CREATE INDEX items_state ON items(state)");
    }

    @Override
    public void onUpgrade(SQLiteDatabase d, int oldV, int newV) { /* first version */ }

    long insert(ContentValues v) {
        return getWritableDatabase().insert("items", null, v);
    }

    void update(String tid, ContentValues v) {
        getWritableDatabase().update("items", v, "tid = ?", new String[]{tid});
    }

    void delete(long id) {
        getWritableDatabase().delete("items", "id = ?", new String[]{String.valueOf(id)});
    }

    JSONObject byTid(String tid) {
        return one("tid = ?", tid);
    }

    JSONObject byId(long id) {
        return one("id = ?", String.valueOf(id));
    }

    private JSONObject one(String where, String arg) {
        JSONArray a = query(where, new String[]{arg}, null);
        return a.length() == 0 ? null : a.optJSONObject(0);
    }

    JSONArray conversation(String peer) {
        return query("peer = ?", new String[]{peer}, "ts ASC, id ASC");
    }

    /** Everything that came in, the newest first. */
    JSONArray received() {
        return query("dir = 'in' AND kind = 'file' AND state = 'done'", new String[0], "ts DESC, id DESC");
    }

    /** Everything still moving or waiting, in the order it was asked for. */
    JSONArray unfinished() {
        return query("kind = 'file' AND state IN ('pending','offered','active','paused','verifying')", new String[0], "ts ASC, id ASC");
    }

    JSONArray outgoingFor(String peer) {
        return query("dir = 'out' AND kind = 'file' AND peer = ? AND state IN ('pending','offered','active','paused')", new String[]{peer}, "ts ASC, id ASC");
    }

    JSONArray peers() {
        JSONArray out = new JSONArray();
        try (Cursor c = getReadableDatabase().rawQuery("SELECT peer, MAX(peer_name), MAX(ts) FROM items GROUP BY peer ORDER BY MAX(ts) DESC", null)) {
            while (c.moveToNext()) {
                JSONObject o = new JSONObject();
                o.put("id", c.getString(0));
                o.put("name", c.getString(1));
                o.put("last", c.getLong(2));
                out.put(o);
            }
        } catch (Exception ignored) { /* an empty list */ }
        return out;
    }

    /** The counter people see: bytes that moved with no mobile data and no server. */
    JSONObject stats() {
        JSONObject o = new JSONObject();
        try (Cursor c = getReadableDatabase().rawQuery("SELECT COALESCE(SUM(size), 0), COUNT(*), COUNT(DISTINCT peer) FROM items WHERE kind = 'file' AND state = 'done'", null)) {
            if (c.moveToFirst()) {
                o.put("bytes", c.getLong(0));
                o.put("files", c.getLong(1));
                o.put("people", c.getLong(2));
            }
        } catch (Exception ignored) { /* zeros */ }
        return o;
    }

    private JSONArray query(String where, String[] args, String order) {
        JSONArray out = new JSONArray();
        try (Cursor c = getReadableDatabase().query("items", null, where, args, null, null, order)) {
            while (c.moveToNext()) {
                JSONObject o = new JSONObject();
                for (String k : TEXT_COLS) o.put(k, c.isNull(c.getColumnIndexOrThrow(k)) ? JSONObject.NULL : c.getString(c.getColumnIndexOrThrow(k)));
                for (String k : NUM_COLS) o.put(k, c.getLong(c.getColumnIndexOrThrow(k)));
                out.put(o);
            }
        } catch (Exception ignored) { /* what was read so far */ }
        return out;
    }
}
