# The daily check that everything is recorded

Every night at **02:30 Tashkent time** (`INTEGRITY_AT`, `INTEGRITY_TZ`) the server checks by itself that nothing is lost. It does not need any device:
the phones and computers of the people may be switched off or without internet. A day that was missed because the server was down at that
time is made up for as soon as it is back.

What is checked (each check is independent):

| Check | What it looks at | What happens on a problem |
| --- | --- | --- |
| Database | `PRAGMA quick_check` | alert |
| Search index | every message is in `msg_fts` | missing rows are added back, the run says how many |
| Files on disk | every file of the database is on the disk with its size; no message points to a missing file | alert with the names of the lost files |
| Unfinished uploads | uploads that a device started and did not finish | a note (the device finishes them when it is back) |
| Scheduled messages | nothing is late by more than 15 minutes | alert |
| Backups | newest copy is fresh and verified | alert |
| Free space | at least 5 GB or 5 % | alert |
| Meaning search | share of messages with a vector | a note |
| Telegram | every linked account catches up on its newest messages (`POST /resync` of the bridge); the run counts what was missing and what is still downloading; accounts without a connection are listed | alert; if the connection is down the whole check is repeated every 20 minutes, up to six times |

Every run is kept (the last 120). The administrator sees the last verdict, each check and the previous days in **Server and copies**, can run it
at once with **Check now**, and gets a message (in the messenger and in Telegram) when something is wrong, and another one when it is fine again.

What the server cannot see: a message that was typed on a device that has not been online since. That one waits in the device's own queue
(the outbox) and is sent the moment the device is back; the check only reports uploads that are half-way on the server.
