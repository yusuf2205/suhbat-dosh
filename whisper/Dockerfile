# Speech-to-text for voice messages. Runs on your own server: audio never leaves it.
FROM python:3.12-slim
# the default PyPI route from some home networks is very slow: a mirror is much faster there (override with --build-arg)
ARG PIP_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple
RUN pip install -i $PIP_INDEX --no-cache-dir faster-whisper==1.1.1
WORKDIR /app
COPY server.py .
ENV WHISPER_MODEL=large-v3 WHISPER_THREADS=5 HF_HOME=/models PYTHONUNBUFFERED=1
EXPOSE 9000
CMD ["python", "server.py"]
