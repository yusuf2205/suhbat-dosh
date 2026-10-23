# Backups

* **What:** a snapshot of the database (users, chats, messages) every 6 hours, and a copy of every uploaded file (only new files are copied, nothing is deleted).
* **How long they are kept:** the ten newest, the newest of each of the last 14 days, 8 weeks and 12 months; snapshots made by hand for 90 days, the ones taken just before a restore for 30 days.
* **Is the copy usable?** Every snapshot is checked when it is made (`PRAGMA integrity_check`). Once a day the newest one is opened on its own and compared with the live data
  (tables present, a sensible number of rows, the uploaded files it refers to are in the second place). A failure is shown in the admin overview and sent to the administrators as a message.
  The button "Проверить" in the admin panel does the same for any snapshot.
* **A second disk.** Copies on the same disk as the data do not survive that disk. Mount a second disk (a USB drive, another volume) into the container and point the copies at it:

  ```
  # .env
  BACKUP_OFFSITE=/mnt/usb/suhbat-backup     # the folder on the host that is mounted at /offsite
  BACKUP_MIRROR_DIR=/offsite/db             # database snapshots, same retention
  BACKUP_FILES_DIR=/offsite/files           # uploaded files
  BACKUP_MIRROR_MARKER=/offsite/.offsite    # an empty file created on that disk (touch /mnt/usb/suhbat-backup/.offsite)
  ```

  The marker stops the server from writing into the empty folder that is left behind when the disk is unplugged (the copies would then land on the system disk and look fine).
  When the disk is missing the admin overview says so.
* **WebDAV** (Nextcloud, Yandex Disk, pCloud): `BACKUP_WEBDAV_URL`, `BACKUP_WEBDAV_USER`, `BACKUP_WEBDAV_PASS` upload every new snapshot.
* **Restore:** admin panel → Сервер и копии → "Восстановить" (the server restarts; a snapshot of the current state is taken first).
* The Telegram bridge sessions (`tgbridge-data` volume) are not part of these copies: they are encrypted with a key that must not sit next to them. After losing them, everybody links again by QR.
