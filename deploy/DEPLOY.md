# TG Vault 服务器部署指南

[首页](../README.md) · [配置参考](../docs/configuration.md) · [本地存储](../docs/local-storage.md)

标准部署使用 **Docker Compose + 宿主机 HTTPS 反向代理**。Compose 包含 `postgres`、`backend`、`frontend`，不包含证书管理服务。默认 Web/API 端口仅绑定宿主机 `127.0.0.1`。

## 1. 前置条件

- Linux、Bash 4+、Python 3.7+、Git、Docker Engine 和 Compose 插件；当前用户能访问 Docker daemon。镜像安装无需 Node.js、npm 或 Buildx。
- Compose 需支持健康等待和镜像拉取策略，检查基线为 2.18+。仅源码兜底需要 Buildx；默认构建证明要求 Compose 2.39+，较旧构建环境可加 `--compat`。不支持 Python `docker-compose` v1；源码兜底遇到额外 Compose 覆盖文件会停止，避免丢失自定义部署配置。
- Web 与 API 两个域名解析到服务器，例如 `cloud.example.com`、`api.example.com`。使用同一主域名下的 HTTPS 子域名，避免 `SameSite=Lax` Cookie 的跨站限制。
- 宿主机 Nginx、管理面板或其他反向代理与证书；独立存储磁盘应提前挂载，并留足下载暂存和备份空间。

环境检查默认只读。缺少组件时，输入 `1` 才授权从 apt（Debian/Ubuntu）或 dnf/yum 的现有仓库安装，可能请求 sudo 密码；按 Enter 或 `q` 退出。脚本不添加软件仓库、关闭签名校验或放宽 Docker socket 权限。

## 2. 首次安装

```bash
git clone https://github.com/hicocos/tg-vault.git
cd tg-vault
./deploy/install.sh
```

**不要先复制 `.env.example`**：安装器会生成 `.env`，而已有 `.env` 会被视为旧部署，不套用新的存储目录默认值。按提示填写：

```dotenv
VITE_API_URL=https://api.example.com
CORS_ORIGIN=https://cloud.example.com
```

使用实际完整 origin（协议、域名及可选端口），不要路径、查询、片段或末尾 `/`。已有值按 Enter 保留，包括误填的示例地址，必须主动替换。安装器不替换 Nginx 示例中的域名。

新安装还会询问服务器文件目录，默认为 `<项目目录>/data`。应选择尚不存在的专用子目录，上级目录必须已存在；安装器以 `0700` 创建并设置 UID/GID `1000:1000`，不递归改其他目录权限。路径支持 ASCII 字母、数字、空格、`/`、`-`、`_`、`.`，不接受符号链接或 `..`。详见[本地存储](../docs/local-storage.md)。

确认页按 Enter 保存并部署，输入 `e` 重填，`q` 取消。脚本自动生成数据库密码、`SESSION_SECRET` 与 `STORAGE_CREDENTIALS_SECRET`，将 `.env` 权限设为 `0600`。保留这些值；已有数据库不能换成新密码。

Telegram 凭证不需要写入 `.env`。完成 HTTPS 和管理员初始化后，在 Web 设置中配置 Bot、允许用户和个人账号。

非交互安装不安装缺失软件，也不读取终端输入。全新部署可使用：

```bash
CORS_ORIGIN=https://cloud.example.com \
VITE_API_URL=https://api.example.com \
INSTALL_STORAGE_PATH=/mnt/archive/tg-vault-data \
./deploy/install.sh --non-interactive
```

`INSTALL_STORAGE_PATH` 仅用于全新非交互安装；已有部署不会因此迁移文件。完整环境变量见[配置参考](../docs/configuration.md)。

## 3. 构建与启动

安装器更新当前分支源码后，依次：

1. 校验部署配置与原有 `/data` 挂载。
2. 拉取 GHCR 最新前后端镜像（`latest`），核对两端源码修订一致；拉取失败、架构不支持或发布不完整时再顺序本地构建。
3. 启动并等待 PostgreSQL 健康，已有数据库容器使用 `--no-recreate` 保留。
4. 替换前后端并等待健康检查；后端启动自动初始化/迁移数据库。

默认等待 180 秒，可用 `INSTALL_HEALTH_TIMEOUT=600 ./deploy/install.sh` 调整（30–1800 秒）。应用镜像始终使用 `latest`，不会使用旧缓存冒充拉取成功；已拉取后启动阶段禁止再次拉取。强制源码构建使用 `--build`，需要时加 `--compat`；构建版本信息从 package 与 Git 临时读取。替换前完成镜像准备，失败不自动清库或重置密钥。

手动运行 Compose 需要自行准备 `.env` 和数据库密码；密码包含 URL 保留字符时还要为连接串提供 URL 编码后的 `DB_PASSWORD_URI`，数据库原密码不变。直接 Compose 使用历史 named volume 默认值，不会执行安装器的目录选择/密钥保护逻辑。已确认配置后可运行：

```bash
docker compose config --quiet
docker compose pull backend frontend
docker compose up -d --no-build --pull never --wait
```

基础 Compose 只负责运行；本地编译配置位于 `docker-compose.build.yml`，建议由安装器 `--build` 调用。前后端镜像发布支持 amd64/arm64；其他平台会尝试源码兜底。首次安装不能只启动 `--no-deps backend frontend`，必须先有 PostgreSQL。

容器构建/后端运行使用 Node.js 24，前端运行由 Nginx 提供。后端通过镜像自带的进程外监督器启动；不要覆盖为 `node dist/index.js`，否则绕过活性保护。监督器针对 `/livez` 连续失败重启进程组，单纯 `/readyz` 降级不会触发此重启。

## 4. 配置宿主机反向代理

| 入口 | 上游 |
| --- | --- |
| `https://cloud.example.com` | `http://127.0.0.1:47832` |
| `https://api.example.com` | `http://127.0.0.1:51947` |

标准部署保留后端 `PORT=51947`。反向代理应转发完整路径、Host、真实客户端 IP、`X-Forwarded-For` 与 `X-Forwarded-Proto`，支持 `Range`/`If-Range`，为上传与媒体响应设置合理超时，不公共缓存鉴权响应。API 上传请求体上限至少容纳默认 32 MiB 分片及 multipart 开销；例如 `client_max_body_size 64m` 可用于默认分片配置，非分片请求仍受此上限限制。

TLS 证书由宿主机或面板管理；不要运行 `docker compose run certbot`。[`nginx-site.conf`](nginx-site.conf) 和 [`nginx-site-init.conf`](nginx-site-init.conf) 是旧单域名示例，不是可直接套用的双域名配置。使用前替换域名、证书路径，补齐 API 站点，核对旧 `/uploads`、`/thumbnails` 路由与公共缓存规则。加载前执行 `nginx -t`；初始 HTTP 站点仅用于证书申请，不用于登录或传输凭证。

**管理员初始化前，仅允许自己访问 Web 和 API 两个入口**（例如临时代理 IP 白名单）。第一个完成初始化的人会设置管理员密码；没有默认管理员凭证或额外安装口令。HTTPS 生效后创建至少 8 位的强密码，再开放服务。在设置中配置 Telegram 与 TOTP，明确 Bot 用户允许列表后再分享 Bot。

默认 `COOKIE_SECURE=true`；全新安装器还写入 `COOKIE_SECURE_FORCE=true`。不要为解决生产登录失败而关闭安全 Cookie：先核对 HTTPS、Web/API 同站域名、`CORS_ORIGIN` 与代理。`VITE_API_URL` 在前端容器启动时注入，修改后重新创建容器，无需编译镜像。

## 5. 更新部署

先完成下一节的备份，从实际项目根目录运行：

```bash
./deploy/install.sh
```

安装器从 `origin` 更新当前分支，只接受快进；本地修改、detached HEAD 或无法快进时停止，不丢弃文件或强行合并。已有地址按 Enter 保留；原数据库和文件挂载保留，不自动迁移数据。已手动更新、固定发布源码或离线部署可使用 `--skip-source-update`。也可通过安装器绝对路径调用，它会定位项目目录。

替换前后端会短暂中断服务；仅重启旧容器不会升级源码或容器内 Node。数据库迁移由后端自动执行，不需要手工应用某个历史迁移。需要回退时，不能假设旧镜像兼容新 schema：先在隔离环境验证，必要时恢复升级前同一批数据库、文件与密钥。

部署后检查：

```bash
docker compose ps
curl -fsS http://127.0.0.1:51947/livez
curl -fsS http://127.0.0.1:51947/readyz
docker compose logs --tail=100 backend frontend postgres
docker inspect --format='{{index .Config.Labels "org.opencontainers.image.revision"}} {{index .Config.Labels "org.opencontainers.image.version"}}' tg-vault-backend tg-vault-frontend
```

两端镜像标签应对应预期源码提交/版本；另用浏览器检查实际 Web/API HTTPS 地址、登录、文件访问与 Telegram 状态。不要仅凭容器运行就认定公网部署完成。

## 6. 常用运维命令

从包含 `docker-compose.yml` 的项目根目录运行：

```bash
docker compose ps --all
docker compose logs -f backend
docker compose logs -f frontend
docker compose logs -f postgres
docker compose restart
docker compose down
```

`down` 停止并删除容器，但不删除 named volume。**不要添加 `-v`**，除非确定要永久删除数据库及文件卷。bind 目录也不能作为临时构建文件删除。备份脚本需要原 backend 容器（可以已停止）来确认实际挂载，运行备份前不要先执行 `down`。

## 7. 备份与恢复

### 协调备份

```bash
BACKUP_DIR=/path/to/secure-backups ./deploy/backup.sh
./deploy/restore-verify.sh /path/to/secure-backups/<timestamp>
```

备份依赖运行中的 PostgreSQL、现有 backend 容器及 Docker 拉取辅助镜像的能力。脚本识别 backend 的实际 `/data` 挂载，支持 bind 与 named volume，不猜卷名。输出目录包含：

- `postgres.dump`：PostgreSQL custom-format dump。
- `file-storage.tar.gz`：完整 `/data`，包含本地文件、缩略图/预览、临时状态、Telegram session 与持久密钥。
- `manifest.txt`：时间、源码修订、一致性标记及 SHA-256。

脚本先检查目标至少可容纳“未压缩 `/data` + 数据库大小 + 512 MiB”。空间不足不会停止 backend。归档期间停止 backend，结束或失败退出时恢复其原运行状态，API/上传/后台任务暂不可用；不要同时运行其他写入工具。

**另行安全备份 `.env` 和自定义反向代理配置，脚本不包含它们。** 远端存储对象不在本地归档中。备份应存到另一块磁盘，加密并异地保存，严格限制访问；不要提交到 GitHub。丢失应用密钥可能导致 TOTP、存储凭证不可读。

`restore-verify.sh` 只读检查清单、校验和及归档格式，不恢复数据。通过不代表应用可恢复；定期进行隔离恢复演练。

### 隔离恢复演练与正式恢复

以下示例**只在独立测试主机或独立 Docker daemon 上执行**，使用空数据库与空存储。仓库 Compose 固定了项目名、容器名和宿主机端口，仅换目录或加 `-p` 不足以避免与生产冲突。不要直接复用生产 bind 目录。

1. 获取备份 manifest 对应的源码和匹配镜像，安全复制原 `.env`，改为测试 HTTPS 地址与代理。原应用加密密钥必须保留。测试可将 `LOCAL_STORAGE_SOURCE=file-storage`、`LOCAL_STORAGE_MOUNT_TYPE=volume`，清空其余 `LOCAL_STORAGE_*` 展示元数据，使用测试 daemon 中的空 named volume。不要用 `latest` 或运行更新安装器进行历史备份恢复。
2. 核对所有挂载均为隔离目标；以下命令用匹配源码构建恢复镜像，再只启动数据库，创建但不启动 backend：

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.build.yml config --quiet
   docker compose -f docker-compose.yml -f docker-compose.build.yml build backend frontend
   docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --no-build --wait postgres
   docker compose -f docker-compose.yml -f docker-compose.build.yml create --no-deps backend
   ```

3. 将备份目录记为 `BACKUP`（必须是安全归档的绝对路径），恢复数据库与完整 `/data`：

   ```bash
   BACKUP=/absolute/path/to/backups/<timestamp>
   docker compose exec -T postgres pg_restore -U tgvault -d tgvault --clean --if-exists --no-owner < "$BACKUP/postgres.dump"
   docker run --rm --volumes-from tg-vault-backend \
     --mount "type=bind,source=$BACKUP,target=/backup,readonly" \
     alpine:3.20 sh -c 'tar -C /data -xzf /backup/file-storage.tar.gz'
   docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --no-build --pull never --wait backend frontend
   ```

   归档解压到 `/data` 根，不额外套一层 uploads；保留归档权限。该命令会覆盖目标内容，因此目标必须为空且已确认隔离。

4. 检查 schema、行数、`/readyz`、管理员登录/TOTP、密钥解密、本地文件与远端存储连接。隔离副本可能持有有效 Telegram 会话与订阅，启动前限制其外网访问，避免与生产同时使用同一会话或执行后台同步。

正式恢复安排维护窗口，停止应用写入后按已演练流程还原同一批数据库、完整 `/data` 与原密钥；验证成功后才切换访问。保留原数据库/卷供回退，不向运行中的数据目录解压覆盖。

## 8. 故障排查

### backend 不健康

```bash
docker compose ps --all
docker compose logs --tail=200 backend
curl -i http://127.0.0.1:51947/livez
curl -i http://127.0.0.1:51947/readyz
```

`/livez=200`、`/readyz=503` 表示进程存活但依赖未就绪，检查数据库、存储、密钥与按需启用的 Telegram 必需状态。不要先清库或替换密钥。

### 数据库连接失败

```bash
docker compose exec postgres pg_isready -U tgvault -d tgvault
docker compose logs --tail=200 postgres
```

`ENOTFOUND postgres` / `EAI_AGAIN` 先检查数据库容器是否存在并启动；认证失败核对原 `DB_PASSWORD`，不要随机生成新密码。密码含特殊字符时核对连接串 URL 编码。

### HTTPS、502 或登录失败

检查宿主机代理、证书、Web/API upstream、请求体与超时限制，核对构建时的 API 地址和运行时 CORS。同站 HTTPS 子域名与安全 Cookie 应一致。Compose 内没有 `nginx` 或 `certbot` 服务；只调整实际负责入口的代理。提交日志前脱敏，不公开 `.env`、session 或数据库归档。
