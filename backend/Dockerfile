# Build stage
FROM node@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS builder

WORKDIR /app

# esbuild 极快且内存占用低，不再需要调高 Node 内存限制

COPY package*.json ./
RUN npm ci

# 复制源代码并构建
COPY . .
RUN npm run build \
    && npx esbuild src/scripts/login_telegram_user.ts --bundle --platform=node --format=esm --outfile=dist/scripts/login_telegram_user.js --packages=external


# Production stage
FROM node@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293

ARG SOURCE_REVISION=unknown
ARG SOURCE_VERSION=worktree
ARG SOURCE_URL=https://github.com/hicocos/tg-vault
LABEL org.opencontainers.image.revision=$SOURCE_REVISION \
      org.opencontainers.image.version=$SOURCE_VERSION \
      org.opencontainers.image.source=$SOURCE_URL

WORKDIR /app

# 安装 sharp 需要的依赖 和 ffmpeg (用于视频处理)
ARG YTDLP_VERSION=2026.06.09
ARG YTDLP_SHA256=e5d57466682cfa9d61e9cf7c8a4f09b00f4a62af37d3bbdc4bcffdf63615feac
RUN apk add --no-cache vips-dev ffmpeg ca-certificates curl \
    && curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp" -o /usr/local/bin/yt-dlp \
    && echo "${YTDLP_SHA256}  /usr/local/bin/yt-dlp" | sha256sum -c - \
    && chmod +x /usr/local/bin/yt-dlp

# 复制依赖
COPY package*.json ./
RUN npm ci --omit=dev

# 复制构建产物
COPY --from=builder /app/dist ./dist
# 复制数据库方案文件 (esbuild 模式下与 index.js 同级)
COPY --from=builder /app/src/db/schema.sql ./dist/schema.sql

# 创建数据目录
RUN mkdir -p /data/uploads /data/thumbnails /data/previews

# 设置权限
RUN chown -R node:node /app /data

USER node

EXPOSE 51947

CMD ["node", "dist/index.js"]
