# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# 复制依赖文件
# 复制依赖文件
COPY package*.json ./
RUN npm config set registry https://registry.npmmirror.com
RUN npm install

# 复制源代码并构建
COPY . .
# 确保 .env 被复制（如果它不在上下文根目录）
COPY .env .env
RUN npm run build


# Production stage
FROM node:20-alpine

WORKDIR /app

# 安装 sharp 需要的依赖 和 ffmpeg (用于视频处理)
RUN apk add --no-cache vips-dev ffmpeg

# 复制依赖
COPY package*.json ./
RUN npm config set registry https://registry.npmmirror.com
RUN npm install --omit=dev

# 复制构建产物
COPY --from=builder /app/dist ./dist

# 创建数据目录
RUN mkdir -p /data/uploads /data/thumbnails

# 设置权限
RUN chown -R node:node /app /data

USER node

EXPOSE 51947

CMD ["node", "dist/index.js"]
