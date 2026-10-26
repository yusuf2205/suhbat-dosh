# Translation between Russian, Uzbek and English on your own server (Meta's NLLB-200, 600M, run by CTranslate2 on the CPU).
# LibreTranslate has no Uzbek; this does, and it speaks the same small API (POST /translate, GET /languages), so the server needs no change.
FROM python:3.12-slim
# the default PyPI route from some home networks is very slow: a mirror may be faster, or may refuse the big wheel (403): pass --build-arg PIP_INDEX=... to change it
ARG PIP_INDEX=https://pypi.org/simple
RUN pip install -i $PIP_INDEX --no-cache-dir ctranslate2==4.5.0 sentencepiece==0.2.0 huggingface_hub patchelf
# some kernels (NAS systems) refuse a library that asks for an executable stack: the flag is not needed, remove it
RUN patchelf --clear-execstack /usr/local/lib/python3.12/site-packages/ctranslate2.libs/libctranslate2-*.so* && python -c "import ctranslate2"
WORKDIR /app
COPY server.py .
ENV HF_HOME=/models PYTHONUNBUFFERED=1 NLLB_REPO=JustFrederik/nllb-200-distilled-600M-ct2-int8 NLLB_THREADS=4 PORT=5000
EXPOSE 5000
USER 1000:1000
CMD ["python", "server.py"]
