# 基于 Playwright 官方镜像（已内置 Chromium 运行时）
FROM mcr.microsoft.com/playwright:v1.59.1-noble

WORKDIR /app

# ffmpeg / ffprobe（下载引擎依赖）
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3456

EXPOSE 3456

VOLUME ["/app/downloads", "/app/data", "/app/logs", "/app/config"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3456/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
