# Docker Hub 部署指南

## 概述

本项目提供两个 Docker 镜像，可通过 Docker Hub 获取：
- `foomclous-frontend`: 前端应用（Nginx + React）
- `foomclous-backend`: 后端服务（Node.js + Express）

## 快速开始

### 使用 Docker Compose 部署

1. 创建 `docker-compose.prod.yml`:

```yaml
version: '3.8'

services:
  # 前端
  frontend:
    image: <你的用户名>/foomclous-frontend:latest
    container_name: foomclous-frontend
    ports:
      - "47832:80"
    environment:
      - VITE_API_URL=https://your-domain.com
    networks:
      - foomclous-network
    restart: unless-stopped

  # 后端
  backend:
    image: <你的用户名>/foomclous-backend:latest
    container_name: foomclous-backend
    ports:
      - "51947:51947"
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      - DATABASE_URL=postgresql://foomclous:${DB_PASSWORD:-foomclous123}@postgres:5432/foomclous
      - PORT=51947
      - UPLOAD_DIR=/data/uploads
      - THUMBNAIL_DIR=/data/thumbnails
      - CHUNK_DIR=/data/chunks
      - CORS_ORIGIN=https://your-domain.com
      - ACCESS_PASSWORD_HASH=${ACCESS_PASSWORD_HASH:-}
      - DOMAIN=your-domain.com
      - TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN:-}
      - TELEGRAM_API_ID=${TELEGRAM_API_ID:-}
      - TELEGRAM_API_HASH=${TELEGRAM_API_HASH:-}
    volumes:
      - file-storage:/data
    networks:
      - foomclous-network
    restart: unless-stopped

  # 数据库
  postgres:
    image: postgres:16-alpine
    container_name: foomclous-postgres
    environment:
      - POSTGRES_DB=foomclous
      - POSTGRES_USER=foomclous
      - POSTGRES_PASSWORD=${DB_PASSWORD:-foomclous123}
    volumes:
      - postgres-data:/var/lib/postgresql/data
      - ./init.sql:/docker-entrypoint-initdb.d/init.sql:ro
    networks:
      - foomclous-network
    restart: unless-stopped
    healthcheck:
      test: [ "CMD-SHELL", "pg_isready -U foomclous -d foomclous" ]
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  file-storage:
    driver: local
  postgres-data:
    driver: local

networks:
  foomclous-network:
    driver: bridge
```

2. 创建数据库初始化文件 `init.sql`:

```sql
-- 文件表
CREATE TABLE IF NOT EXISTS files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    original_name VARCHAR(255) NOT NULL,
    size BIGINT NOT NULL,
    mime_type VARCHAR(100),
    path VARCHAR(500) NOT NULL,
    thumbnail_path VARCHAR(500),
    folder_id UUID REFERENCES files(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    access_count INTEGER DEFAULT 0,
    storage_provider VARCHAR(50) DEFAULT 'local',
    is_deleted BOOLEAN DEFAULT FALSE
);

-- API Key 表
CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key_name VARCHAR(100) NOT NULL,
    key_hash VARCHAR(255) NOT NULL UNIQUE,
    permissions JSONB DEFAULT '[]',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP,
    is_active BOOLEAN DEFAULT TRUE
);

-- 系统设置表
CREATE TABLE IF NOT EXISTS system_settings (
    key VARCHAR(100) PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_files_folder_id ON files(folder_id);
CREATE INDEX IF NOT EXISTS idx_files_created_at ON files(created_at);
CREATE INDEX IF NOT EXISTS idx_files_original_name ON files(original_name);
```

3. 创建 `.env` 文件:

```env
DB_PASSWORD=your_secure_password
ACCESS_PASSWORD_HASH=your_hashed_password
DOMAIN=your-domain.com
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_API_ID=your_api_id
TELEGRAM_API_HASH=your_api_hash
```

4. 启动服务:

```bash
docker-compose -f docker-compose.prod.yml up -d
```

### 手动使用 Docker 镜像

#### 拉取镜像

```bash
docker pull <你的用户名>/foomclous-frontend:latest
docker pull <你的用户名>/foomclous-backend:latest
```

#### 运行前端

```bash
docker run -d \
  --name foomclous-frontend \
  -p 47832:80 \
  -e VITE_API_URL=https://your-domain.com \
  <你的用户名>/foomclous-frontend:latest
```

#### 运行后端

```bash
docker run -d \
  --name foomclous-backend \
  -p 51947:51947 \
  -e DATABASE_URL=postgresql://foomclous:password@postgres:5432/foomclous \
  -e PORT=51947 \
  -e UPLOAD_DIR=/data/uploads \
  -e THUMBNAIL_DIR=/data/thumbnails \
  -e CHUNK_DIR=/data/chunks \
  -e CORS_ORIGIN=https://your-domain.com \
  -v foomclous-data:/data \
  --network foomclous-network \
  <你的用户名>/foomclous-backend:latest
```

## GitHub Actions 自动构建

### 配置 Secrets

在 GitHub 仓库的 Settings > Secrets and variables > Actions 中添加以下 Secrets:

| Secret 名称 | 说明 | 示例 |
|-------------|------|------|
| `DOCKER_USERNAME` | Docker Hub 用户名 | `johndoe` |
| `DOCKER_PASSWORD` | Docker Hub 密码或 Access Token | `dckr_pat_...` |
| `IMAGE_NAME` | Docker Hub 镜像名称 | `johndoe/foomclous` |

### 触发构建

工作流会在以下情况下自动触发：
- 推送到 `main` 或 `master` 分支
- 推送标签（如 `v1.0.0`）
- 手动触发（在 Actions 页面点击 "Run workflow"）

### 版本标签

推送时自动生成的标签示例：
- `latest` - 最新版本
- `v1.2.3` - 完整版本号
- `v1.2` - 主版本.次版本
- `v1` - 主版本
- `sha-abc123` - Git commit SHA

### Docker Hub Access Token

推荐使用 Access Token 而不是密码：
1. 登录 [Docker Hub](https://hub.docker.com/)
2. 进入 Account Settings > Security
3. 点击 "New Access Token"
4. 输入描述和权限（Read, Write, Delete）
5. 复制生成的 token

## 本地构建和推送

### 构建镜像

```bash
# 构建 Backend
docker build -t your-username/foomclous-backend:latest ./backend

# 构建 Frontend
docker build -t your-username/foomclous-frontend:latest ./frontend
```

### 推送到 Docker Hub

```bash
# 登录
docker login

# 推送
docker push your-username/foomclous-backend:latest
docker push your-username/foomclous-frontend:latest
```

## 镜像信息

| 镜像 | 基础镜像 | 大小 | 说明 |
|------|---------|------|------|
| `foomclous-frontend` | `nginx:alpine` | ~30MB | 静态文件服务 |
| `foomclous-backend` | `node:20-alpine` | ~150MB | API 服务 |

### 环境变量

#### Backend

| 变量 | 必需 | 默认值 | 说明 |
|------|------|--------|------|
| `DATABASE_URL` | 是 | - | PostgreSQL 连接字符串 |
| `PORT` | 否 | `51947` | 服务端口 |
| `UPLOAD_DIR` | 否 | `/data/uploads` | 上传文件目录 |
| `THUMBNAIL_DIR` | 否 | `/data/thumbnails` | 缩略图目录 |
| `CHUNK_DIR` | 否 | `/data/chunks` | 分块上传临时目录 |
| `CORS_ORIGIN` | 是 | - | CORS 允许的源 |
| `ACCESS_PASSWORD_HASH` | 否 | - | 访问密码哈希 |
| `DOMAIN` | 否 | - | 域名 |
| `TELEGRAM_BOT_TOKEN` | 否 | - | Telegram Bot Token |
| `TELEGRAM_API_ID` | 否 | - | Telegram API ID |
| `TELEGRAM_API_HASH` | 否 | - | Telegram API Hash |

#### Frontend

| 变量 | 必需 | 默认值 | 说明 |
|------|------|--------|------|
| `VITE_API_URL` | 是 | - | 后端 API 地址 |

## 端口映射

| 服务 | 容器端口 | 宿主机端口 | 说明 |
|------|---------|-----------|------|
| Frontend | 80 | 47832 | HTTP |
| Backend | 51947 | 51947 | API |

## 数据持久化

使用 Docker Volume 持久化数据：

```bash
# 查看卷
docker volume ls

# 备份卷
docker run --rm -v foomclous-data:/data -v $(pwd):/backup alpine tar czf /backup/foomclous-data-backup.tar.gz /data

# 恢复卷
docker run --rm -v foomclous-data:/data -v $(pwd):/backup alpine tar xzf /backup/foomclous-data-backup.tar.gz -C /
```

## Nginx 反向代理配置

如果你有域名，可以配置 Nginx 反向代理：

```nginx
# 前端
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    location / {
        proxy_pass http://localhost:47832;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

# 后端 API
server {
    listen 443 ssl http2;
    server_name api.your-domain.com;

    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    location / {
        proxy_pass http://localhost:51947;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 500M;
    }
}
```

## 常见问题

### 1. 镜像拉取失败

```bash
# 重新登录 Docker Hub
docker login
```

### 2. 数据库连接失败

检查 `DATABASE_URL` 环境变量和网络配置是否正确。

### 3. 上传文件失败

检查存储目录权限和磁盘空间。

### 4. 查看日志

```bash
# 查看所有容器日志
docker-compose logs -f

# 查看特定容器日志
docker logs -f foomclous-backend
docker logs -f foomclous-frontend
```

## 更新镜像

```bash
# 拉取最新镜像
docker-compose pull

# 重新创建容器
docker-compose up -d
```

## 停止和清理

```bash
# 停止容器
docker-compose down

# 停止并删除卷（警告：会删除数据！）
docker-compose down -v
```

## 安全建议

1. **使用强密码**：数据库和访问密码应使用强密码
2. **定期更新**：定期拉取最新镜像更新
3. **HTTPS**：生产环境必须使用 HTTPS
4. **防火墙**：限制不必要的端口访问
5. **备份**：定期备份数据卷
6. **日志监控**：监控容器日志发现异常

## 支持

如有问题，请提交 Issue 或联系维护者。
