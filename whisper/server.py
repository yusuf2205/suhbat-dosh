"""Tiny HTTP wrapper around faster-whisper.

POST /transcribe?lang=ru   (body: the audio file, any format PyAV can read)
  -> {"language": "ru", "language_probability": 0.98, "duration": 12.3, "text": "...",
      "words": [{"w": "привет", "p": 0.97}, ...], "model": "large-v3"}
GET  /health -> {"status": "ok", "model": "..."}
One request at a time (a single lock): the job queue lives in the application server.
"""
import json
import os
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from faster_whisper import WhisperModel

MODEL_NAME = os.environ.get("WHISPER_MODEL", "large-v3")
THREADS = int(os.environ.get("WHISPER_THREADS", "4"))
MAX_BYTES = 60 * 1024 * 1024
LANGS = {"ru", "uz", "en", "kk", "tg", "tr", "uk"}

print(f"loading {MODEL_NAME} ...", flush=True)
model = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8", cpu_threads=THREADS)
print("model ready", flush=True)
lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if urlparse(self.path).path == "/health":
            return self._json(200, {"status": "ok", "model": MODEL_NAME})
        return self._json(404, {"error": "not_found"})

    def do_POST(self):
        u = urlparse(self.path)
        if u.path != "/transcribe":
            return self._json(404, {"error": "not_found"})
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > MAX_BYTES:
            return self._json(413, {"error": "bad_size"})
        lang = (parse_qs(u.query).get("lang") or [""])[0]
        lang = lang if lang in LANGS else None
        data = self.rfile.read(n)
        with tempfile.NamedTemporaryFile(suffix=".bin") as tmp:
            tmp.write(data)
            tmp.flush()
            try:
                with lock:
                    segments, info = model.transcribe(
                        tmp.name, language=lang, beam_size=5, vad_filter=True,
                        word_timestamps=True, condition_on_previous_text=False,
                        temperature=0.0,
                    )
                    words, parts = [], []
                    for seg in segments:
                        parts.append(seg.text.strip())
                        for w in seg.words or []:
                            words.append({"w": w.word.strip(), "p": round(float(w.probability), 2)})
            except Exception as e:  # undecodable audio etc.
                return self._json(422, {"error": "decode_failed", "detail": str(e)[:200]})
        return self._json(200, {
            "language": info.language, "language_probability": round(float(info.language_probability), 2),
            "duration": round(float(info.duration), 1), "text": " ".join(p for p in parts if p),
            "words": words, "model": MODEL_NAME,
        })

    def log_message(self, *a):
        pass


ThreadingHTTPServer(("0.0.0.0", 9000), Handler).serve_forever()
