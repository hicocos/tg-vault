# TG Vault 服务器部署指南

[首页](../README.md) · [配置参考](../docs/configuration.md) · [本地存储](../docs/local-storage.md)

标准部署使用 **Docker Compose + 宿主机 HTTPS 反向代理**。Compose 包含 `postgres`、独立迁移服务 `db-migrate`、`backend`、`frontend`，不包含证书管理服务。默认 Web/API 端口仅绑定宿主机 `127.0.0.1`。

## 1. 前置条件

- Linux、Bash 4+、Python 3.7+、Git、Docker Engine 和 Compose 插件；一键下载入口还需要 curl。当前用户能访问 Docker daemon。镜像安装无需 Node.js、npm 或 Buildx。
- Compose 需支持健康等待和镜像拉取策略，检查基线为 2.18+。源码构建需要 Buildx；默认构建证明要求 Compose 2.39+，较旧构建环境可加 `--compat`。不支持 Python `docker-compose` v1；源码兜底遇到额外 Compose 覆盖文件会停止，避免丢失自定义部署配置。
- Web 与 API 两个域名解析到服务器，例如 `cloud.example.com`、`api.example.com`。使用同一主域名下的 HTTPS 子域名，避免 `SameSite=Lax` Cookie 的跨站限制。
- 宿主机 Nginx、管理面板或其他反向代理与证书；独立存储磁盘应提前挂载，并留足下载暂存和备份空间。

环境检查默认只读。缺少组件时，输入 `1` 可从系统软件仓库安装，可能请求 sudo 密码；按 Enter 或 `q` 退出。

## 2. 首次安装

```bash
curl -fsSL https://raw.githubusercontent.com/hicocos/tg-vault/main/install.sh | bash
```

入口需要 Bash 4+、curl 和 Git，自动下载项目到当前目录下的 `tg-vault` 并运行 `deploy/install.sh`，无需手动下载或 `cd`。通过管道执行时，向导从终端读取输入。

指定安装目录（当前用户需有写入权限）：

```bash
curl -fsSL https://raw.githubusercontent.com/hicocos/tg-vault/main/install.sh | TG_VAULT_INSTALL_DIR=/opt/tg-vault bash
```

在项目根目录重复执行会复用当前项目；从其他目录运行时，使用相同的 `TG_VAULT_INSTALL_DIR` 可更新已有部署。已有非项目目录不会被覆盖。`--build`、`--compat`、`--skip-source-update` 和 `--non-interactive` 可通过 `bash -s -- <参数>` 传入。

后续手动执行 Compose 或运维脚本时，先进入项目根目录（默认 `cd tg-vault`）。

安装器会自动生成 `.env`。按提示填写：

```dotenv
VITE_API_URL=https://api.example.com
CORS_ORIGIN=https://cloud.example.com
```

填写实际 origin（协议、域名及可选端口），不带路径、查询、片段或末尾 `/`。已有值按 Enter 保留，示例地址须主动替换；Nginx 示例域名也需另行修改。MCP 地址按 API 地址自动配置，自定义值见[配置参考](../docs/configuration.md)。

新安装还会询问服务器文件目录，默认为 `<项目目录>/data`。选择尚不存在的专用子目录，上级目录须已存在；安装器创建权限 `0700`、UID/GID `1000:1000`。路径字符与挂载要求见[本地存储](../docs/local-storage.md)。

确认页按 Enter 保存并部署，输入 `e` 重填，`q` 取消。脚本自动生成数据库密码、`SESSION_SECRET` 与 `STORAGE_CREDENTIALS_SECRET`，将 `.env` 权限设为 `0600`。保留这些值；已有数据库不能换成新密码。

Telegram 凭证不需要写入 `.env`。完成 HTTPS 和管理员初始化后，在 Web 设置中配置 Bot、允许用户和个人账号。

非交互安装不安装缺失软件，也不读取终端输入。已下载项目并进入项目根目录时，可使用：

```bash
CORS_ORIGIN=https://cloud.example.com \
VITE_API_URL=https://api.example.com \
INSTALL_STORAGE_PATH=/mnt/archive/tg-vault-data \
./deploy/install.sh --non-interactive
```

如果尚未下载项目，可直接运行：

```bash
curl -fsSL https://raw.githubusercontent.com/hicocos/tg-vault/main/install.sh | CORS_ORIGIN=https://cloud.example.com VITE_API_URL=https://api.example.com INSTALL_STORAGE_PATH=/mnt/archive/tg-vault-data bash -s -- --non-interactive
```

`INSTALL_STORAGE_PATH` 仅用于全新非交互安装；已有部署不会因此迁移文件。完整环境变量见[配置参考](../docs/configuration.md)。

## 3. 构建与启动

安装器更新当前分支源码后，依次：

1. 校验部署配置与原有 `/data` 挂载。
2. 拉取配套的 GHCR `latest` 镜像；拉取失败、架构不支持或发布不完整时尝试源码构建。
3. 启动并等待 PostgreSQL 健康，保留已有数据库容器。
4. 停止旧应用，使用目标 backend 镜像执行数据库迁移；成功后替换前后端并检查健康状态。迁移失败时保持应用停止。

健康检查默认等待 180 秒，可用 `INSTALL_HEALTH_TIMEOUT=600 ./deploy/install.sh` 调整（30–1800 秒）。强制源码构建使用 `--build`，较旧构建环境可加 `--compat`。

手动运行 Compose 需要自行准备 `.env` 和数据库密码；密码包含 URL 保留字符时还要为连接串提供 URL 编码后的 `DB_PASSWORD_URI`，数据库原密码不变。直接 Compose 使用历史 named volume 默认值，不会执行安装器的目录选择/密钥保护逻辑。首次安装确认配置后可运行：

```bash
docker compose config --quiet
docker compose pull backend frontend db-migrate
docker compose up -d --no-build --pull never --wait
```

Compose 会在 PostgreSQL 健康后运行独立 `db-migrate` 服务，迁移成功才启动 backend，适用于空库安装。backend 启动只检查迁移状态，不执行 DDL；不要挂载 `init.sql` 代替迁移。首次安装不能只启动 `--no-deps backend frontend`。预构建镜像支持 amd64/arm64；源码构建使用 `docker-compose.build.yml`，建议通过安装器 `--build` 调用。

后端使用 Node.js 24，前端由 Nginx 提供。保留镜像自带的启动命令，以启用进程活性保护。

### 源码部署

部署当前工作区时，所有 Compose 命令均附加 `-f docker-compose.yml -f docker-compose.build.yml`；只用基础文件会选择 GHCR 镜像。数据库仍按下文先检查、迁移，再替换应用，保留原数据库与数据卷。

不要用 `git clean -fdx` 清理部署目录或删除容器引用的文件。开发及发布检查使用[独立副本](../docs/development.md)。

### 数据库命令与手动升级

数据库 CLI 为 `node dist/scripts/database.js status|plan|migrate|check`。`status` 查看账本，`plan` 列出待执行迁移，`check` 验证版本，三者均只读；只有 `migrate` 执行初始化及迁移。超时参数见[配置参考](../docs/configuration.md)。

已有部署必须先完成第 7 节的协调备份并准备好目标镜像，再停止旧应用，不能让旧 workers 与 DDL 同时运行。以下命令逐条执行；任何一步失败立即停止，保持应用停止，不继续最后一步：

```bash
docker compose pull backend frontend db-migrate
docker compose up -d --no-build --no-deps --no-recreate --wait postgres
docker compose stop backend frontend
docker compose run --rm --no-deps --pull never backend node dist/scripts/database.js plan
docker compose run --rm --no-deps --pull never backend node dist/scripts/database.js migrate
docker compose up -d --no-build --pull never --no-deps --wait backend frontend
```

所有命令必须使用同一套 Compose 覆盖文件和选定镜像；自定义 backend 镜像时也要将 db-migrate 指向相同镜像。迁移失败先检查错误与账本，保留数据库并前向修复；不要删除数据卷或修改已发布迁移。

## 4. 配置宿主机反向代理

| 入口 | 上游 |
| --- | --- |
| `https://cloud.example.com` | `http://127.0.0.1:47832` |
| `https://api.example.com` | `http://127.0.0.1:51947` |

标准部署保留后端 `PORT=51947`。反向代理应转发完整路径、Host、真实客户端 IP、`X-Forwarded-For` 与 `X-Forwarded-Proto`，支持 `Range`/`If-Range`，为上传与媒体响应设置合理超时，不公共缓存鉴权响应。API 上传请求体上限至少容纳默认 32 MiB 分片及 multipart 开销；例如 `client_max_body_size 64m` 可用于默认分片配置，非分片请求仍受此上限限制。

TLS 证书由宿主机或面板管理；Compose 没有 `certbot` 服务。[`nginx-site-init.conf`](nginx-site-init.conf) 仅提供双域名 ACME HTTP 验证，不代理应用；签发两个域名的证书后，用 [`nginx-site.conf`](nginx-site.conf) 的双域名 HTTPS 配置替换。替换域名、证书路径和非默认 API 端口，确认 ACME webroot 已存在；不要同时加载两份示例。执行 `nginx -t` 通过后再加载。示例保留上游鉴权与缓存头，不单独暴露文件目录。

**管理员初始化前，仅允许自己访问 Web 和 API 两个入口**（例如临时代理 IP 白名单）。第一个完成初始化的人会设置管理员密码；没有默认管理员凭证或额外安装口令。HTTPS 生效后创建至少 8 位的强密码，再开放服务。在设置中配置 Telegram 与 TOTP，明确 Bot 用户允许列表后再分享 Bot。

默认 `COOKIE_SECURE=true`；全新安装器还写入 `COOKIE_SECURE_FORCE=true`。不要为解决生产登录失败而关闭安全 Cookie：先核对 HTTPS、Web/API 同站域名、`CORS_ORIGIN` 与代理。`VITE_API_URL` 在前端容器启动时注入，修改后重新创建容器，无需编译镜像。

## 5. 更新部署

先完成[协调备份](#协调备份)，从实际项目根目录运行：

```bash
curl -fsSL https://raw.githubusercontent.com/hicocos/tg-vault/main/install.sh | bash
```

安装器从 `origin` 快进更新当前分支；有本地修改、detached HEAD 或无法快进时停止。原配置、数据库和文件挂载保留，不自动迁移数据。已手动更新、固定发布源码或离线部署可使用 `--skip-source-update`。

替换前后端会短暂中断服务；重启旧容器不会完成升级。迁移失败后保持应用停止，优先前向修复。回退前须验证旧镜像与 schema 的兼容性，必要时恢复升级前同一批数据库、文件与密钥，再运行匹配镜像。

部署后检查：

```bash
docker compose ps
curl -fsS http://127.0.0.1:51947/livez
curl -fsS http://127.0.0.1:51947/readyz
docker compose logs --tail=100 backend frontend postgres
docker inspect --format='{{index .Config.Labels "org.opencontainers.image.revision"}} {{index .Config.Labels "org.opencontainers.image.version"}}' tg-vault-backend tg-vault-frontend
```

两端镜像标签应对应预期源码提交/版本；另用浏览器检查实际 Web/API HTTPS 地址、登录、文件访问与 Telegram 状态。不要仅凭容器运行就认定公网部署完成。

自定义 Compose 须把 `VITE_API_URL` 传入前端容器环境，不能只写在 build args；可通过 `/runtime-config.js` 核对，空值使用同源 `/api`。OAuth 回调与登录 API 须使用同一主机，前后端镜像应配套更新。

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

检查宿主机代理、证书、Web/API upstream、请求体与超时限制，核对前端容器启动时注入的 API 地址和运行时 CORS。同站 HTTPS 子域名与安全 Cookie 应一致。Compose 内没有 `nginx` 或 `certbot` 服务；只调整实际负责入口的代理。提交日志前脱敏，不公开 `.env`、session 或数据库归档。

### 视频拖动或断点下载返回整文件

对比后端直连与公开 HTTPS 的相同 Range 请求。正常范围应返回 `206`、`Content-Range` 和对应片段；越界范围应返回 `416`。宿主机反代须显式转发 `Range`、`If-Range` 并设置 `proxy_cache off`、`proxy_buffering off`，避免继承面板全局 `proxy_cache` 后把范围请求变成整文件 `200`。仓库的 `nginx-site.conf` 已包含这些设置；修改实际站点后先 `nginx -t`，再平滑重载。
