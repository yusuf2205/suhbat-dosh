"""Russian <-> Uzbek <-> English translation on the CPU (NLLB-200 through CTranslate2), with a LibreTranslate-shaped API:
POST /translate {q, source, target}  ->  {translatedText, detectedLanguage: {language}};  GET /languages.
The model (about 600 MB) is downloaded once into /models. Texts are never logged."""
import json
import os
import re
import threading
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "5000"))
REPO = os.environ.get("NLLB_REPO", "JustFrederik/nllb-200-distilled-600M-ct2-int8")
THREADS = int(os.environ.get("NLLB_THREADS", "4"))
CODES = {"ru": "rus_Cyrl", "uz": "uzn_Latn", "en": "eng_Latn"}

READY = {"ok": False, "translator": None, "sp": None}
LOCK = threading.Lock()
CACHE: "OrderedDict[tuple, str]" = OrderedDict()


def log(*a):
    print(*a, flush=True)


def load():
    import ctranslate2
    import sentencepiece
    from huggingface_hub import snapshot_download
    path = snapshot_download(REPO, local_dir=os.path.join(os.environ.get("HF_HOME", "/models"), "nllb"))
    READY["sp"] = sentencepiece.SentencePieceProcessor(os.path.join(path, "sentencepiece.bpe.model"))
    READY["translator"] = ctranslate2.Translator(path, device="cpu", compute_type="int8", inter_threads=1, intra_threads=THREADS)
    READY["ok"] = True
    log("model ready")


# ---------------------------------------------------------------- which language is this text in
CYR = re.compile(r"[Ѐ-ӿ]")
LAT = re.compile(r"[A-Za-z]")
UZ_ONLY = set("ўқғҳЎҚҒҲ")
UZ_WORDS = set("va bu men sen siz biz ular emas yoq bor xop rahmat salom qanday nima uchun bilan kerak yaxshi bugun ertaga kecha kel ket ber ham lekin ammo endi hozir qayer necha kim qachon assalomu alaykum aka opa uka ota ona qani mayli shunday juda boldi kechirasiz iltimos xayr qalaysiz".split())
EN_WORDS = set("the and is are you i to of in it that this for with was have not hello thanks thank please what when where why how can will would".split())

TR = {"а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "yo", "ж": "j", "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o",
      "п": "p", "р": "r", "с": "s", "т": "t", "у": "u", "ф": "f", "х": "x", "ц": "ts", "ч": "ch", "ш": "sh", "ъ": "ʼ", "ь": "", "э": "e", "ю": "yu", "я": "ya",
      "ў": "oʻ", "қ": "q", "ғ": "gʻ", "ҳ": "h"}


def translit(text: str) -> str:
    out = []
    for ch in text:
        low = ch.lower()
        if low in TR:
            r = TR[low]
            out.append(r.capitalize() if ch != low and r else r)
        else:
            out.append(ch)
    return "".join(out)


def detect(text: str) -> str:
    """ru, uz (Latin), uzc (Uzbek in Cyrillic), en, or '' when there are no letters."""
    cyr, lat = len(CYR.findall(text)), len(LAT.findall(text))
    if not cyr and not lat:
        return ""
    if cyr >= lat:
        return "uzc" if any(c in UZ_ONLY for c in text) else "ru"
    norm = text.lower().replace("’", "'").replace("ʻ", "'").replace("‘", "'").replace("`", "'")
    words = re.findall(r"[a-z']+", norm)
    uz = sum(1 for w in words if w in UZ_WORDS) + len(re.findall(r"[og]'", norm))
    en = sum(1 for w in words if w in EN_WORDS)
    return "en" if en > uz else "uz"


def chunks(text: str, limit=240):
    """The text as lines, each a list of sentences: the model tends to drop the rest when it gets several, so one sentence goes at a time
    (a tiny fragment is joined to its neighbour)."""
    out = []
    for line in text.split("\n"):
        sentences = []
        cur = ""
        for part in re.split(r"(?<=[.!?…])\s+", line.strip()):
            if cur and (len(cur) >= 12 or len(cur) + len(part) + 1 > limit):
                sentences.append(cur)
                cur = part
            else:
                cur = f"{cur} {part}".strip()
        if cur:
            sentences.append(cur)
        out.append(sentences)
    return out


def run(texts, src, tgt):
    sp, tr = READY["sp"], READY["translator"]
    sources = [[CODES[src]] + sp.encode(t, out_type=str) + ["</s>"] for t in texts]
    with LOCK:
        res = tr.translate_batch(sources, target_prefix=[[CODES[tgt]]] * len(sources), beam_size=2, max_decoding_length=256, max_batch_size=8)
    return [sp.decode(r.hypotheses[0][1:]) for r in res]


def translate(text: str, target: str):
    lang = detect(text)
    if not lang:
        return text, ""
    src = "uz" if lang == "uzc" else lang
    if lang == "uzc":
        text = translit(text)
        if target == "uz":
            return text, "uz"
    if src == target:
        return text, src
    key = (text, src, target)
    if key in CACHE:
        CACHE.move_to_end(key)
        return CACHE[key], src
    lines = chunks(text)
    todo = [x for ln in lines for x in ln]
    done = iter(run(todo, src, target)) if todo else iter(())
    out = "\n".join(" ".join(next(done) for _ in ln) for ln in lines)
    CACHE[key] = out
    if len(CACHE) > 3000:
        CACHE.popitem(last=False)
    return out, src


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body):
        raw = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path.startswith("/languages") and READY["ok"]:
            return self.send(200, [{"code": c, "name": c} for c in CODES])
        self.send(503, {"error": "loading"})

    def do_POST(self):
        if not self.path.startswith("/translate"):
            return self.send(404, {"error": "not_found"})
        if not READY["ok"]:
            return self.send(503, {"error": "loading"})
        try:
            body = json.loads(self.rfile.read(min(int(self.headers.get("content-length", "0")), 20000)) or b"{}")
            text, target = str(body.get("q", ""))[:2000], str(body.get("target", ""))
            if target not in CODES or not text.strip():
                return self.send(400, {"error": "invalid_input"})
            out, src = translate(text, target)
            self.send(200, {"translatedText": out, "detectedLanguage": {"language": src, "confidence": 80}})
        except Exception as e:
            log("translate failed:", type(e).__name__)
            self.send(500, {"error": "failed"})


if __name__ == "__main__":
    threading.Thread(target=load, daemon=True).start()
    log("listening on", PORT)
    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()
