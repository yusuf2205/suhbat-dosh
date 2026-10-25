# Bridge to your own Telegram account (Telethon). Runs only inside the Docker network: no published ports.
FROM python:3.12-slim
ARG PIP_INDEX=https://pypi.org/simple
COPY requirements.txt /tmp/requirements.txt
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/* \
 && pip install -i $PIP_INDEX --no-cache-dir -r /tmp/requirements.txt && useradd -r -u 10001 bridge && mkdir /data && chown bridge /data
WORKDIR /app
COPY bridge.py .
USER bridge
ENV PYTHONUNBUFFERED=1 DATA_DIR=/data
EXPOSE 9200
CMD ["python", "bridge.py"]
