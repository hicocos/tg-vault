# Build stage
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS builder

WORKDIR /app

# 安装依赖
COPY package*.json ./
RUN npm ci

# 复制源代码
COPY . .

# [重要] 允许构建时指定 API 地址
# 使用方法: docker build --build-arg VITE_API_URL=https://your-api.domain.com ./frontend
ARG VITE_API_URL=
ENV VITE_API_URL=${VITE_API_URL}

RUN NODE_OPTIONS=--max-old-space-size=768 npm run build

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

# An unset runtime override retains a source-build default; an explicit empty value uses /api.
ARG VITE_API_URL=
ENV TG_VAULT_DEFAULT_API_URL=${VITE_API_URL} \
    PORT=51947 \
    NGINX_ENVSUBST_FILTER="^(PORT|API_ORIGIN)$"
COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY --chmod=755 scripts/19-runtime-config.envsh /docker-entrypoint.d/19-runtime-config.envsh

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
