# cowove relay + website. Build: docker build -t cowove-relay .   Run: see docs/hosting.md

# Bundle the website (needs dev dependencies; they don't ship in the image).
FROM node:22-alpine AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY scripts ./scripts
COPY src ./src
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache su-exec
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY bin ./bin
COPY src ./src
COPY assets ./assets
COPY web ./web
COPY --from=web /app/web/dist ./web/dist
COPY deploy/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && mkdir -p /data && chown node:node /data
ENV COWOVE_DATA=/data \
    PORT=4321
VOLUME /data
EXPOSE 4321
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "bin/cowove.js", "serve"]
