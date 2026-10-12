package app.suhbat.mobile;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import androidx.core.content.ContextCompat;

/** Starts the background connection after the phone has been restarted. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String a = intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(a) && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)) return;
        String origin = context.getSharedPreferences(PushService.PREFS, Context.MODE_PRIVATE).getString(PushService.KEY_ORIGIN, null);
        if (origin == null) return;
        try {
            ContextCompat.startForegroundService(context, new Intent(context, PushService.class));
        } catch (Exception ignored) { /* the system may refuse; the next app start brings it back */ }
    }
}
