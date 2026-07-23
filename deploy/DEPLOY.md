# TG Vault 服务器部署指南

TG Vault 当前采用 **Docker Compose + 宿主机 Nginx/面板反向代理**。Compose 只包含 `postgres`、`backend`、`frontend`，不包含 Nginx 或 Certbot 服务。

## 1. 前置条件

- Debian/Ubuntu 服务器，已安装 Docker Engine 和 Compose 插件。
- 已把 Web 域名和 API 域名解析到服务器。
- 宿主机 Nginx、宝塔或其他反向代理负责 HTTPS 证书。
- 从项目目录执行下列命令；项目目录即包含 `docker-compose.yml` 的目录。

## 2. 创建环境变量

```bash
cp .env.example .env 2>/dev/null || touch .env
nano .env
```

`.env` 使用普通 `KEY=value`，不要加 `export`。至少填写：

```dotenv
DB_PASSWORD=使用 openssl rand -hex 32 生成的随机值
IMAGE_VERSION=v2.0.1
VITE_API_URL=https://api.example.com
OAUTH_CALLBACK_BASE_URL=https://api.example.com
OAUTH_FRONTEND_ORIGIN=https://cloud.example.com
CORS_ORIGIN=https://cloud.example.com
DOMAIN=cloud.example.com
COOKIE_SECURE=true
```

可选但建议显式保存：

```dotenv
SESSION_SECRET=至少32字符；可用 openssl rand -hex 32
STORAGE_CREDENTIALS_SECRET=至少32字符；可用 openssl rand -hex 32
```

如果这两个值留空，后端会在 `file-storage` 卷的 `/data/secrets` 中持久生成。迁移与恢复时必须同时备份该卷，否则已加密的 2FA 和存储凭证可能无法读取。

## 3. 构建并启动

```bash
docker compose config --quiet
docker compose up -d --build
docker compose ps
```

数据库 schema 会在后端启动时自动检查/迁移。`postgres`、`backend`、`frontend` 都配置了健康检查；只有 `/readyz` 通过后 backend 才为 healthy。

## 4. 配置宿主机反向代理

仓库示例：`deploy/nginx-site.conf`。按照实际域名调整后加载到宿主机 Nginx：

- Web 域名代理至 `http://127.0.0.1:47832`
- API 域名代理至 `http://127.0.0.1:51947`
- API 上传链路的 `client_max_body_size` 必须与应用配置一致
- TLS 证书由宿主机 Nginx/面板/Certbot 管理，不要运行 `docker compose run certbot`

## 5. 更新部署

从项目目录执行完整更新：

```bash
git fetch origin
git status --short
git pull --ff-only origin main
docker compose up -d --build
```

如果 `git status --short` 显示本地改动，先人工确认，不要强制覆盖。

可选验证：

```bash
docker compose ps
curl -fsS http://127.0.0.1:51947/livez
curl -fsS http://127.0.0.1:51947/readyz
docker compose logs --tail=100 backend frontend postgres
```

## 6. 常用运维命令

```bash
docker compose ps
docker compose logs -f backend
docker compose logs -f frontend
docker compose logs -f postgres
docker compose restart
docker compose down
```

`docker compose down` 不会删除 named volumes；不要添加 `-v`，除非明确要永久删除数据库和文件数据。

## 7. 备份与恢复

备份必须包含同一维护窗口内的：

1. PostgreSQL custom-format dump
2. `file-storage` 卷中的完整 `/data`（包括 secrets、缩略图和未完成上传状态）
3. 版本、时间和 SHA-256 manifest

仓库脚本：

```bash
chmod +x deploy/backup.sh deploy/restore-verify.sh
BACKUP_DIR=./backups ./deploy/backup.sh
```

脚本会先按“文件卷未压缩大小 + PostgreSQL 数据库大小 + 512 MiB 安全余量”保守检查备份目标可用空间；空间不足时会在停止 backend 前直接退出。通过预检后，脚本会在 `pg_dump` 与 `/data` 归档的整个窗口内停止 backend（完成后或失败退出时自动恢复），从而阻止 Web/chunk 上传、删除和 Telegram 后台写入跨越两个快照。manifest 必须包含 `consistency=backend-stopped`，且校验和使用备份目录内 basename，供恢复验证器直接校验。备份窗口内 API 会暂时不可用，请安排维护时段。

备份目录可能包含敏感凭证材料，应加密后异地保存并限制访问。恢复前在隔离环境执行：

```bash
./deploy/restore-verify.sh ./backups/<backup-directory>
```

恢复验证不会替代生产恢复演练；应定期在隔离 Compose 项目中验证 schema、行数、密钥可读性和 `/readyz`。

## 8. 故障排查

### backend 不健康

```bash
docker compose ps
docker compose logs --tail=200 backend
curl -i http://127.0.0.1:51947/livez
curl -i http://127.0.0.1:51947/readyz
```

`/livez=200` 但 `/readyz=503` 表示进程存活，但数据库、存储或安全密钥尚不可用。

### 数据库连接失败

```bash
docker compose exec postgres pg_isready -U tgvault -d tgvault
docker compose logs --tail=200 postgres
```

### HTTPS/502

检查宿主机 Nginx 配置、证书、Web/API upstream 端口和请求体限制。Compose 内不存在 `nginx` 或 `certbot` 服务。
