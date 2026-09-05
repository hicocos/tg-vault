# TG Vault 服务器部署指南

TG Vault 当前采用 **Docker Compose + 宿主机 Nginx/面板反向代理**。Compose 只包含 `postgres`、`backend`、`frontend`，不包含 Nginx 或 Certbot 服务。

## 1. 前置条件

- Debian/Ubuntu 服务器，已安装 Docker Engine 和 Compose 插件。
- 已把 Web 域名和 API 域名解析到服务器。
- 宿主机 Nginx、宝塔或其他反向代理负责 HTTPS 证书。
- 从项目目录执行下列命令；项目目录即包含 `docker-compose.yml` 的目录。

## 2. 创建环境变量

推荐先运行一次安装脚本。首次部署它会创建 `.env`、生成数据库密码和应用密钥；版本信息只在构建命令中临时注入，不写入 `.env`：

```bash
./deploy/install.sh
```

首次运行只需要填写以下 2 项：

```dotenv
VITE_API_URL=https://api.example.com
CORS_ORIGIN=https://cloud.example.com
```

两项都应是完整的 HTTPS origin，不带路径、查询参数或末尾 `/`。安装脚本会校验并在确认后构建启动。

**Telegram 不属于首次部署的 `.env` 配置。** 服务启动并完成 Web 管理员初始化后，再进入 Web「设置 → Telegram」配置 Bot、允许用户、账号登录和下载并发。不要为了第一次部署手工填写 `TELEGRAM_*`、session 路径或并发变量；这些变量只为旧版本兼容和高级运维保留。

新安装时，脚本会自动生成并保留：

```dotenv
DB_PASSWORD=随机生成的64位十六进制密码
SESSION_SECRET=随机生成的64位十六进制密钥
STORAGE_CREDENTIALS_SECRET=随机生成的64位十六进制密钥
```

升级已有部署时，如果 `.env` 没有 `SESSION_SECRET` 或 `STORAGE_CREDENTIALS_SECRET`，脚本不会突然写入新值覆盖 `/data/secrets` 中已有的持久密钥，避免现有 2FA 与存储凭证失效。

OAuth 默认使用 `VITE_API_URL` 作为回调来源，并使用 `CORS_ORIGIN` 的第一个地址作为前端通知来源。只有多入口或特殊反代部署才需显式设置 `OAUTH_CALLBACK_BASE_URL`、`OAUTH_FRONTEND_ORIGIN`。

如果不使用安装脚本而直接运行 Compose，至少需要手动生成 `DB_PASSWORD`；镜像名称会使用 `source`，镜像标签中的源码版本元数据会分别回退为 `unknown` / `worktree`。

## 3. 构建并启动

版本号不保存在 `.env`。使用 `deploy/install.sh` 时，应用版本直接读取 `backend/package.json`，源码修订号读取当前 Git 提交，并只在本次 Compose 调用中传入。直接运行 Compose 时，镜像名称和标签元数据会回退为 `source` / `unknown` / `worktree`。手动构建时可临时传入：

```bash
revision=$(git rev-parse HEAD)
version="v$(node -p "require('./backend/package.json').version")"
IMAGE_VERSION="$version" SOURCE_REVISION="$revision" SOURCE_VERSION="$version" docker compose up -d --build
```

```bash
docker compose config --quiet
docker compose up -d --build
docker compose ps
```

安装脚本先构建 `backend` 和 `frontend`，再通过 `--no-deps` 只替换这两个服务，不会重建 PostgreSQL。数据库 schema 会在后端启动时自动检查/迁移。`postgres`、`backend`、`frontend` 都配置了健康检查；只有 `/readyz` 通过后 backend 才为 healthy。

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
./deploy/install.sh
```

如果 `git status --short` 显示本地改动，先人工确认，不要强制覆盖。

升级时重新运行 `./deploy/install.sh`：向导会显示已有 Web/API URL，直接按 Enter 保留即可；如果地址不是本次部署要使用的地址，输入 `e` 返回修改，确认后才会开始构建。脚本只重建并替换 `backend` 和 `frontend`，不会重建 PostgreSQL，也不会删除 Docker 持久化卷。

可选验证：

```bash
docker compose ps
curl -fsS http://127.0.0.1:51947/livez
curl -fsS http://127.0.0.1:51947/readyz
docker compose logs --tail=100 backend frontend postgres

expected_revision=$(git rev-parse HEAD)
expected_version="v$(node -p "require('./backend/package.json').version")"
docker inspect --format='{{index .Config.Labels "org.opencontainers.image.revision"}} {{index .Config.Labels "org.opencontainers.image.version"}}' tg-vault-backend tg-vault-frontend
# 两个容器都必须输出 "$expected_revision $expected_version"。

# 验证运行中的前端入口 asset；必须与刚构建镜像中的 index.html 一致。
docker exec tg-vault-frontend sh -c 'grep -oE "assets/[^\"]+\.(js|css)" /usr/share/nginx/html/index.html | sort'
curl -fsS http://127.0.0.1:47832/ | grep -oE 'assets/[^\"]+\.(js|css)' | sort
```

只有 OCI revision/version、镜像内 `assets/` 入口与 HTTP 返回的入口全部一致，才可宣称部署成功。

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
