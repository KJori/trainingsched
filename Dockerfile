FROM node:22-alpine
LABEL org.opencontainers.image.title="trainingsched" \
      org.opencontainers.image.description="Self-hosted training planner and log with an honest AI coach" \
      org.opencontainers.image.source="https://github.com/KJori/trainingsched"
WORKDIR /app
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data TS_DOCKER=1
COPY package.json ./
COPY server ./server
COPY public ./public
COPY app ./app
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=60s --timeout=5s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
CMD ["node", "server/server.js"]
