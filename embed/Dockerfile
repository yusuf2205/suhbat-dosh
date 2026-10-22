# Text embeddings for search by meaning (multilingual-e5-small, 100 languages incl. Russian and Uzbek). Runs on your own server.
FROM python:3.12-slim
# the default PyPI route from some home networks is very slow: a mirror is much faster there (override with --build-arg)
ARG PIP_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple
RUN pip install -i $PIP_INDEX --no-cache-dir onnxruntime tokenizers huggingface_hub numpy
WORKDIR /app
COPY server.py .
ENV HF_HOME=/models PYTHONUNBUFFERED=1 EMBED_THREADS=2
EXPOSE 9100
CMD ["python", "server.py"]
