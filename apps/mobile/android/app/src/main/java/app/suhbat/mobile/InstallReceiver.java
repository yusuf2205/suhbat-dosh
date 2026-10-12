package app.suhbat.mobile;

import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.os.Build;
import android.widget.Toast;

/** Result of the self-update session: asks for confirmation only when Android requires it, and reports failures. */
public class InstallReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        String message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirm = Build.VERSION.SDK_INT >= 33
                    ? intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent.class)
                    : (Intent) intent.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirm != null) {
                confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                try {
                    Updater.confirmShown = true;
                    context.startActivity(confirm);
                    return;
                } catch (Exception e) {
                    Updater.confirmShown = false;
                    Updater.lastError = String.valueOf(e.getMessage());
                }
            }
            Updater.installing = false;
            Updater.notifyReady(context, Updater.version);
            return;
        }
        Updater.installing = false;
        if (status == PackageInstaller.STATUS_SUCCESS) {
            ((NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE)).cancel(7001);
            return;
        }
        // cancelled by the user is not an error; anything else is shown
        if (status != PackageInstaller.STATUS_FAILURE_ABORTED) {
            Updater.lastError = status + ": " + (message == null ? "" : message);
            Toast.makeText(context, "Установка не удалась (" + Updater.lastError + ")", Toast.LENGTH_LONG).show();
        }
        Updater.notifyReady(context, Updater.version);
    }
}
