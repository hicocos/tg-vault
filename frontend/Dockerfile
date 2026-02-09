# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# 安装依赖
COPY package*.json ./
RUN npm config set registry https://registry.npmmirror.com
RUN npm ci

# 复制源代码
COPY . .

# [重要] 允许构建时指定 API 地址
# 使用方法: docker build --build-arg VITE_API_URL=https://your-api.domain.com ./frontend
ARG VITE_API_URL=http://localhost:51947
ENV VITE_API_URL=${VITE_API_URL}

RUN npm run build

# Production stage
FROM nginx:alpine

# 复制构建产物
COPY --from=builder /app/dist /usr/share/nginx/html

# 复制 nginx 配置
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
