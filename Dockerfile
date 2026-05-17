FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    dumb-init \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    novnc \
    websockify \
    x11vnc \
    xvfb \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY config.example.json config.docker.example.json README.md ./
COPY src ./src
COPY docker ./docker

RUN chmod +x /app/docker/entrypoint.sh

ENV DISPLAY=:99 \
  WEIBO_MONITOR_CONFIG=/app/data/config.json \
  WEIBO_MONITOR_CONFIG_TEMPLATE=/app/config.docker.example.json \
  WEIBO_MONITOR_UI_HOST=0.0.0.0 \
  WEIBO_MONITOR_UI_PORT=18787 \
  WEIBO_MONITOR_OPEN_BROWSER_ON_START=0

EXPOSE 18787 18790

ENTRYPOINT ["dumb-init", "--", "/app/docker/entrypoint.sh"]
CMD ["node", "src/server.js"]
