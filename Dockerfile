FROM node:24-alpine

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server ./server
COPY shared ./shared
COPY web ./web
COPY scripts ./scripts

# Run as an unprivileged user; /data is the only writable location.
RUN addgroup -S suhbat && adduser -S suhbat -G suhbat && mkdir -p /data /backups && chown -R suhbat:suhbat /data /backups
USER suhbat
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "server/src/index.js"]
