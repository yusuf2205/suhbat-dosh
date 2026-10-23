package app.suhbat.mobile;

import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.webkit.CookieManager;

import androidx.core.app.RemoteInput;

import org.json.JSONObject;

import java.util.UUID;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/** The buttons of a message notification: answer right from the shade, and mark the chat as read. The session cookie is the WebView's. */
public class NotifyActionReceiver extends BroadcastReceiver {
    static final String ACT_REPLY = "app.suhbat.mobile.REPLY";
    static final String ACT_READ = "app.suhbat.mobile.MARK_READ";
    static final String ACT_DISMISS = "app.suhbat.mobile.DISMISSED";
    static final String KEY_REPLY = "reply_text";
    private static final MediaType JSON = MediaType.parse("application/json; charset=utf-8");

    @Override
    public void onReceive(Context context, Intent intent) {
        final long chatId = intent.getLongExtra("chat_id", 0);
        final long lastId = intent.getLongExtra("last_id", 0);
        final String action = intent.getAction();
        if (ACT_DISMISS.equals(action)) { PushService.forget(chatId); return; }
        final Bundle input = RemoteInput.getResultsFromIntent(intent);
        final CharSequence typed = input != null ? input.getCharSequence(KEY_REPLY) : null;
        final PendingResult pending = goAsync();
        final Context app = context.getApplicationContext();
        new Thread(() -> {
            boolean ok = false;
            try {
                String origin = app.getSharedPreferences(PushService.PREFS, Context.MODE_PRIVATE).getString(PushService.KEY_ORIGIN, null);
                String cookie = origin == null ? null : CookieManager.getInstance().getCookie(origin);
                if (origin != null && cookie != null && chatId > 0) {
                    OkHttpClient client = new OkHttpClient();
                    JSONObject body = new JSONObject();
                    String path;
                    if (ACT_REPLY.equals(action) && typed != null && typed.toString().trim().length() > 0) {
                        path = "/api/chats/" + chatId + "/messages";
                        body.put("text", typed.toString().trim());
                        body.put("client_id", UUID.randomUUID().toString());
                    } else if (ACT_READ.equals(action)) {
                        path = "/api/chats/" + chatId + "/read";
                        body.put("message_id", lastId);
                    } else {
                        path = null;
                    }
                    if (path != null) {
                        Request req = new Request.Builder().url(origin + path).header("Cookie", cookie)
                                .post(RequestBody.create(JSON, body.toString())).build();
                        try (Response r = client.newCall(req).execute()) { ok = r.isSuccessful(); }
                    }
                }
            } catch (Exception ignored) { /* shown below as not sent */ }
            PushService.afterAction(app, chatId, ACT_REPLY.equals(action), typed == null ? "" : typed.toString(), ok);
            pending.finish();
        }).start();
    }
}
