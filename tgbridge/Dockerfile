# Bridge to your own Telegram account (Telethon). Runs only inside the Docker network: no published ports.
FROM python:3.12-slim
ARG PIP_INDEX=https://pypi.org/simple
COPY requirements.txt /tmp/requirements.txt
# PyAV (its own ffmpeg libraries) turns recorded voice messages into what Telegram plays; without it they are sent as they are
RUN pip install -i $PIP_INDEX --no-cache-dir --only-binary=:all: av || echo 'PyAV not installed: voice messages are sent as recorded'
RUN pip install -i $PIP_INDEX --no-cache-dir -r /tmp/requirements.txt && useradd -r -u 10001 bridge && mkdir /data && chown bridge /data
WORKDIR /app
COPY bridge.py .
USER bridge
ENV PYTHONUNBUFFERED=1 DATA_DIR=/data
EXPOSE 9200
CMD ["python", "bridge.py"]
