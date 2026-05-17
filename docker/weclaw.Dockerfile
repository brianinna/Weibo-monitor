ARG ALPINE_IMAGE=m.daocloud.io/docker.io/library/alpine:3.20
FROM ${ALPINE_IMAGE}

ARG TARGETARCH
ARG WECLAW_VERSION=latest

RUN sed -i 's|https\?://dl-cdn.alpinelinux.org/alpine|https://mirrors.aliyun.com/alpine|g' /etc/apk/repositories \
  && apk add --no-cache ca-certificates curl

RUN set -eu; \
  case "${TARGETARCH:-amd64}" in \
    amd64) arch="amd64" ;; \
    arm64) arch="arm64" ;; \
    *) echo "Unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  if [ "$WECLAW_VERSION" = "latest" ]; then \
    version="$(curl -fsSL -H "User-Agent: weibo-monitor-docker" https://api.github.com/repos/fastclaw-ai/weclaw/releases/latest | sed -n 's/.*"tag_name" *: *"\([^"]*\)".*/\1/p')"; \
  else \
    version="$WECLAW_VERSION"; \
  fi; \
  test -n "$version"; \
  curl -fsSL -o /usr/local/bin/weclaw "https://github.com/fastclaw-ai/weclaw/releases/download/${version}/weclaw_linux_${arch}"; \
  chmod +x /usr/local/bin/weclaw; \
  weclaw --help >/dev/null

COPY docker/weclaw-entrypoint.sh /usr/local/bin/weclaw-entrypoint
RUN chmod +x /usr/local/bin/weclaw-entrypoint

ENTRYPOINT ["weclaw-entrypoint"]
