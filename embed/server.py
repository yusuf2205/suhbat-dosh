"""Tiny HTTP service: POST /embed {"texts": [...], "kind": "passage" | "query"} -> {"vectors": [[...]], "dim": 384}.

multilingual-e5-small through ONNX Runtime on the CPU. The model is downloaded once into /models.
Vectors are normalised, so the dot product of two vectors is their cosine similarity.
"""
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import onnxruntime as ort
from huggingface_hub import hf_hub_download
from tokenizers import Tokenizer

REPO = os.environ.get("EMBED_REPO", "Xenova/multilingual-e5-small")
FILE = os.environ.get("EMBED_FILE", "onnx/model_quantized.onnx")
PORT = int(os.environ.get("PORT", "9100"))
MAX_TOKENS = 256
MAX_BATCH = 64

print("loading model", REPO, FILE, flush=True)
tokenizer = Tokenizer.from_file(hf_hub_download(REPO, "tokenizer.json"))
tokenizer.enable_truncation(max_length=MAX_TOKENS)
tokenizer.enable_padding()
opts = ort.SessionOptions()
opts.intra_op_num_threads = int(os.environ.get("EMBED_THREADS", "2"))
session = ort.InferenceSession(hf_hub_download(REPO, FILE), opts, providers=["CPUExecutionProvider"])
INPUTS = {i.name for i in session.get_inputs()}
lock = threading.Lock()
print("ready; inputs:", sorted(INPUTS), flush=True)


def embed(texts, kind):
    prefix = "query: " if kind == "query" else "passage: "
    enc = tokenizer.encode_batch([prefix + t for t in texts])
    ids = np.array([e.ids for e in enc], dtype=np.int64)
    mask = np.array([e.attention_mask for e in enc], dtype=np.int64)
    feed = {"input_ids": ids, "attention_mask": mask}
    if "token_type_ids" in INPUTS:
        feed["token_type_ids"] = np.zeros_like(ids)
    with lock:
        hidden = session.run(None, feed)[0]  # (batch, tokens, dim)
    m = mask[..., None].astype(np.float32)
    pooled = (hidden * m).sum(axis=1) / np.clip(m.sum(axis=1), 1e-9, None)
    pooled /= np.clip(np.linalg.norm(pooled, axis=1, keepdims=True), 1e-9, None)
    return pooled.astype(np.float32)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def _send(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"ok": True, "model": REPO})
        else:
            self._send(404, {"error": "not_found"})

    def do_POST(self):
        if self.path != "/embed":
            return self._send(404, {"error": "not_found"})
        try:
            n = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(min(n, 4_000_000)))
            texts = [str(t)[:2000] for t in body.get("texts", [])][:MAX_BATCH]
            if not texts:
                return self._send(400, {"error": "no_texts"})
            vecs = embed(texts, body.get("kind", "passage"))
            return self._send(200, {"vectors": np.round(vecs, 5).tolist(), "dim": int(vecs.shape[1])})
        except Exception as e:  # never crash the service on one bad request
            return self._send(500, {"error": str(e)[:200]})


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
