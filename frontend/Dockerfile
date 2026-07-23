# Build stage
FROM node@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS builder

WORKDIR /app

# 安装依赖
COPY package*.json ./
RUN npm ci

# 复制源代码
COPY . .

# [重要] 允许构建时指定 API 地址
# 使用方法: docker build --build-arg VITE_API_URL=https://your-api.domain.com ./frontend
ARG VITE_API_URL=http://localhost:51947
ENV VITE_API_URL=${VITE_API_URL}

RUN npm run build

# Production stage
FROM nginx@sha256:4a73073bd557c65b759505da037898b61f1be6cbcc3c2c3aeac22d2a470c1752

ARG SOURCE_REVISION=unknown
ARG SOURCE_VERSION=worktree
ARG SOURCE_URL=https://github.com/hicocos/tg-vault
LABEL org.opencontainers.image.revision=$SOURCE_REVISION \
      org.opencontainers.image.version=$SOURCE_VERSION \
      org.opencontainers.image.source=$SOURCE_URL

# 复制构建产物
COPY --from=builder /app/dist /usr/share/nginx/html

# 复制 nginx 配置
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
