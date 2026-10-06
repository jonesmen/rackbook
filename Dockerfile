# syntax=docker/dockerfile:1

# ---------- Build: Abhängigkeiten installieren & Frontend-Assets bereitstellen ----------
# Läuft immer nativ auf der Build-Plattform (keine QEMU-Emulation für npm). Alle
# Abhängigkeiten sind reines JavaScript, node_modules ist daher plattformunabhängig.
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY scripts ./scripts
COPY server ./server
COPY public ./public
RUN npm run build && npm prune --omit=dev

# ---------- Runtime: minimal, ohne Root-Rechte ----------
FROM node:22-alpine
LABEL org.opencontainers.image.title="Rackbook" \
      org.opencontainers.image.description="Selbstgehostete Markdown-Dokumentation für Homelab & IT-Infrastruktur" \
      org.opencontainers.image.source="https://github.com/jonesmen/rackbook"
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/public ./public
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
