# Build stage
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS builder

WORKDIR /app

# Native dependencies may not ship prebuilt binaries for every supported architecture.
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci

# 复制源代码并构建
COPY . .
RUN npm run build


# Production stage
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

ARG SOURCE_REVISION=unknown
ARG SOURCE_VERSION=worktree
ARG SOURCE_URL=https://github.com/hicocos/tg-vault
LABEL org.opencontainers.image.revision=$SOURCE_REVISION \
      org.opencontainers.image.version=$SOURCE_VERSION \
      org.opencontainers.image.source=$SOURCE_URL

WORKDIR /app

# 安装 sharp 需要的依赖 和 ffmpeg (用于视频处理)
RUN apk add --no-cache vips-dev ffmpeg ca-certificates curl

# 复制依赖
COPY package*.json ./
RUN apk add --no-cache --virtual .native-build-deps python3 make g++ \
    && npm ci --omit=dev \
    && apk del .native-build-deps

# 复制构建产物
COPY --from=builder /app/dist ./dist
COPY scripts/runtime-supervisor.mjs ./runtime-supervisor.mjs
# 复制数据库方案文件 (esbuild 模式下与 index.js 同级)
COPY --from=builder /app/src/db/schema.sql ./dist/schema.sql
COPY --from=builder /app/src/db/migrations ./dist/migrations

# 创建数据目录
RUN mkdir -p /data/uploads /data/thumbnails /data/previews

# 设置权限
RUN chown -R node:node /app /data

USER node

EXPOSE 51947

CMD ["node", "runtime-supervisor.mjs"]
