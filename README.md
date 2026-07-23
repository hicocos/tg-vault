<p align="center">
  <img src="backend/logo.png" alt="TG Vault Logo" width="150" />
</p>

<h1 align="center">TG Vault</h1>

<p align="center">
  <img src="https://img.shields.io/github/license/hicocos/tg-vault?style=flat-square&color=blue" alt="License" />
  <img src="https://img.shields.io/github/stars/hicocos/tg-vault?style=flat-square&color=gold" alt="Stars" />
  <img src="https://img.shields.io/github/forks/hicocos/tg-vault?style=flat-square&color=lightgrey" alt="Forks" />
  <img src="https://img.shields.io/github/issues/hicocos/tg-vault?style=flat-square&color=red" alt="Issues" />
  <img src="https://img.shields.io/badge/Docker-Compose-blue?style=flat-square" alt="Docker Compose" />
</p>

<p align="center">
  <strong>TG Vault</strong> 是面向个人和小团队的 Telegram 转存与私有云存储系统。它提供 Web 文件管理、Telegram Bot 上传、yt-dlp 链接下载、频道/群组媒体转存、订阅同步、自动归档和多存储源接入。
</p>

---

## ✨ 功能概览

| 模块 | 能力 |
| :--- | :--- |
| Web 管理 | 文件上传、分片大文件上传、文件夹、预览、删除、存储源管理 |
| 存储源 | 本地、OneDrive、Google Drive、阿里云 OSS、S3 兼容存储、WebDAV |
| Telegram Bot 基础能力 | 私聊发文件转存、任务队列、存储统计、删除文件、yt-dlp 下载 |
| Telegram 账号级下载器 | 频道/群组按日期或标签批量抓取、订阅同步、大文件更稳定下载 |
| 自动归档 | 默认按来源/频道和文件类型保存，例如 `telegram/channel/images/file.jpg` |
| 安全 | 首次初始化管理员、HttpOnly Cookie、Origin 校验、签名 URL、TOTP 双重验证 |

> **账号级下载器不是 Bot 基础功能的前提。** 不生成用户账号 session 时，Bot 仍可收文件、管理任务、查看统计、删除文件和运行 `/ytdlp`；只有频道/群组批量抓取、订阅同步、以及突破 Bot 限制的大文件下载需要账号级下载器。

---

## 🚀 快速部署 (Docker Compose)

### 1. 克隆仓库

```bash
git clone https://github.com/hicocos/tg-vault.git
cd tg-vault
```

### 2. 配置环境变量

```bash
cp .env.example .env
vi .env
```

| 使用场景 | 需要填写/执行 |
| :--- | :--- |
| 基础 Web 部署 | `DB_PASSWORD`、`VITE_API_URL`、`CORS_ORIGIN`、`DOMAIN` |
| 启用 Telegram Bot 基础能力 | 额外填写 `TELEGRAM_BOT_TOKEN`、`TELEGRAM_API_ID`、`TELEGRAM_API_HASH`；建议同时填写 `TELEGRAM_ALLOWED_USER_IDS` |
| 启用账号级 Telegram 下载器 | 在 Bot 基础配置之后，运行登录脚本生成 `TELEGRAM_USER_SESSION_FILE` |

### 3. 构建前端

`VITE_API_URL` 是前端构建时变量。请先在 `.env` 中设置好它，然后用变量传入构建命令：

```bash
set -a
source .env
set +a

docker build \
  --build-arg VITE_API_URL="${VITE_API_URL}" \
  -t tg-vault-frontend:latest \
  ./frontend
```

### 4. 构建后端

```bash
docker build -t tg-vault-backend:latest ./backend
```

### 5. 生成用户账号 session（可选）

仅在需要账号级 Telegram 下载器时执行。该命令会使用 `docker-compose.yml` 中的 `/data` 持久化卷，默认写入 `.env` 里的 `TELEGRAM_USER_SESSION_FILE` 路径。

```bash
docker compose run --rm --no-deps backend npm run login:telegram-user
```

如果暂时只用 Bot 基础能力，可以跳过这一步。

### 6. 启动服务

```bash
docker compose up -d
```

> [!IMPORTANT]
> 修改 `VITE_API_URL` 后必须重新构建前端镜像；仅重启容器不会改变已经打包进前端静态文件的 API 地址。

---

## 🛠️ 环境变量配置

### 必填项

| 变量名 | 说明 | 示例 |
| :--- | :--- | :--- |
| `DB_PASSWORD` | PostgreSQL 数据库密码 | `change_me_to_a_strong_password` |
| `VITE_API_URL` | 前端访问后端的公网 API 地址，必须包含协议 | `https://api.yourdomain.com` |
| `CORS_ORIGIN` | 允许跨域的前端来源 | `https://cloud.yourdomain.com` |
| `DOMAIN` | 应用主域名，不带协议 | `cloud.yourdomain.com` |

### Telegram 相关

| 变量名 | 什么时候需要 | 说明 |
| :--- | :--- | :--- |
| `TELEGRAM_BOT_TOKEN` | 启用 Bot 基础能力 | 从 [@BotFather](https://t.me/BotFather) 获取 |
| `TELEGRAM_API_ID` | 启用 Bot 或账号级下载器 | 从 [my.telegram.org](https://my.telegram.org) 获取；Bot 与账号级下载器共用 |
| `TELEGRAM_API_HASH` | 启用 Bot 或账号级下载器 | 与 `TELEGRAM_API_ID` 同页获取；Bot 与账号级下载器共用这一组 API 配置 |
| `TELEGRAM_ALLOWED_USER_IDS` | 建议，限制谁可以通过 Bot PIN 登录 | Telegram 数字 user id，多个用英文逗号分隔；可让用户私聊 `@userinfobot` 查看 Id |
| `TELEGRAM_USER_SESSION_FILE` | 可选，启用账号级下载器 | 默认 `/data/telegram_user_session.txt`；运行登录脚本生成 |
| `TELEGRAM_DOWNLOAD_WORKERS` | 可选，调单文件分片并发 | 默认 `4`，建议 `4` 或 `8`；`12/16` 更激进，可能触发限流 |
| `TELEGRAM_FILE_DOWNLOAD_CONCURRENCY` | 可选，调一次同时下载几个文件 | 默认 `2`，可在 Bot 里用 `/file_concurrency` 设置 `1/2/3/4`；选择 `4` 需要二次确认 |

### 常用可选项

| 变量名 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `PORT` | `51947` | 后端监听端口 |
| `UPLOAD_DIR` | `/data/uploads` | 文件保存根目录（容器内路径） |
| `THUMBNAIL_DIR` | `/data/thumbnails` | 缩略图目录 |
| `CHUNK_DIR` | `/data/chunks` | 分片上传缓存目录 |
| `DUPLICATE_FILE_MODE` | `copy` | 重复文件策略：`copy` 生成副本，`skip` 跳过同名同目录同大小文件 |
| `AUTO_CLEANUP_ORPHANS` | `true` | 是否自动清理本地 uploads 中未登记到数据库的孤儿文件 |
| `YTDLP_BIN` | `yt-dlp` | yt-dlp 可执行文件路径 |
| `YTDLP_WORK_DIR` | `/data/uploads/ytdlp` | yt-dlp 下载临时目录（Compose 部署） |
| `YTDLP_MAX_CONCURRENT` | `1` | yt-dlp 并发任务数 |

### 限流与安全项

| 变量名 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `TELEGRAM_RATE_WINDOW_MS` / `TELEGRAM_RATE_MAX` | `60000` / `30` | Bot 普通消息限流：默认每分钟 30 次 |
| `TELEGRAM_HEAVY_RATE_WINDOW_MS` / `TELEGRAM_HEAVY_RATE_MAX` | `600000` / `5` | Bot 重型命令限流：默认每 10 分钟 5 次 |
| `TRUST_PROXY` | `loopback` | Express 反代信任范围；本机 Nginx/Caddy 反代推荐保持默认 |
| `COOKIE_SECURE` | `true` | 登录 Cookie 仅通过 HTTPS 发送；本地 HTTP 调试可临时设为 `false` |
| `JSON_BODY_LIMIT` | `2mb` | 普通 JSON API 请求体大小限制，不是文件大小限制 |
| `MAX_UPLOAD_CHUNK_MB` | `32` | Web 分片上传单片最大 MiB |
| `MAX_CHUNK_UPLOAD_GB` / `CHUNK_GLOBAL_BUDGET_GB` | `20` / `40` | 单任务上限与所有未完成分片会话的总预算 |
| `CHUNK_DISK_RESERVE_GB` | `8` | 分片写入后必须保留的最小可用磁盘空间 |
| `MAX_TOTAL_CHUNKS` | `50000` | 单个上传任务允许的最大分片数 |
| `ORPHAN_CLEANUP_MIN_AGE_MS` | `600000` | 本地孤儿文件清理保护期，默认 10 分钟内不清理 |

---

## 🤖 Telegram 配置与能力

### Bot 与账号级下载器的区别

| 能力 | 只启用 Bot | 额外启用账号级下载器 |
| :--- | :---: | :---: |
| 私聊发送文件给 Bot 转存 | ✅ | ✅ |
| 任务管理、存储统计、删除文件 | ✅ | ✅ |
| `/ytdlp` 下载视频链接 | ✅ | ✅ |
| 频道/群组按日期或标签批量抓取 | ❌ | ✅ |
| 频道订阅自动同步 | ❌ | ✅ |
| 超过 Bot 限制的大文件下载 | 可能失败 | 更稳定 |

### 获取 Bot Token

1. 在 Telegram 中搜索 [@BotFather](https://t.me/BotFather) 并开始对话。
2. 发送 `/newbot`，按提示创建机器人。
3. 复制 BotFather 返回的 `HTTP API TOKEN`。
4. 写入 `.env` 的 `TELEGRAM_BOT_TOKEN`。

### 获取 API ID 和 API Hash

1. 访问 [my.telegram.org](https://my.telegram.org) 并登录 Telegram 账号。
2. 进入 `API development tools`。
3. 创建应用后复制 `api_id` 和 `api_hash`。
4. 写入 `.env` 的 `TELEGRAM_API_ID` / `TELEGRAM_API_HASH`。
5. 如果启用账号级下载器，继续运行 `docker compose run --rm --no-deps backend npm run login:telegram-user` 生成用户账号 session。

### Telegram Bot 允许用户

TG Vault 会限制能通过 Bot PIN 登录的 Telegram 用户。推荐在 `.env` 中填写：

```env
TELEGRAM_ALLOWED_USER_IDS=123456789,987654321
```

获取 user id：让用户在 Telegram 私聊 `@userinfobot` 查看 `Id`。如果部署时留空，系统会在“还没有任何 Telegram 用户认证成功”时，把第一个正确输入 Bot PIN 的用户自动加入后台允许列表；之后可以在 Web 后台的 **设置 → Telegram Bot 设置** 中动态维护允许列表。

### 账号级下载器什么时候需要？

账号级下载器会用你登录的 Telegram 用户账号读取媒体。只有下面这些场景建议启用：

- 频道/群组转存：用户账号需要加入对应频道/群组，并确保能看到历史媒体。
- 按日期/标签批量抓取：`/tg_download date`、`/tg_download tag` 依赖用户账号访问来源消息。
- 频道订阅同步：`/tg_sub` 后台扫描依赖用户账号读取频道/群组新消息。
- 大文件下载：Bot 直接下载受 Telegram Bot 限制影响，账号级下载器通常更稳定。

### Telegram 文件与分片并发调参

TG Vault 有两层 Telegram 下载并发：

| 命令 / 配置 | 控制什么 | 可选值 |
| :--- | :--- | :--- |
| `/file_concurrency` / `TELEGRAM_FILE_DOWNLOAD_CONCURRENCY` | 一次同时下载几个文件 | `1` / `2` / `3` / `4`，选择 `4` 需要二次确认 |
| `/download_workers` / `TELEGRAM_DOWNLOAD_WORKERS` | 单个文件内部同时拉几个 512KB 分片 | `4` / `8` / `12` / `16`，选择 `12/16` 需要二次确认 |

建议组合：

- 稳定优先：文件级 `1`，分片 `4`
- 默认推荐：文件级 `2`，分片 `4`
- 速度优先：文件级 `3`，分片 `4` 或 `8`
- 激进模式：文件级 `4` 或分片 `12/16`，可能触发 Telegram 限流、断流或云盘上传限速

> Telegram 单次 `upload.getFile` 请求最大约 512KB。分片 worker 调的是单个文件内部请求数；文件级并发调的是队列中同时跑几个文件。

---

## 🧭 Telegram Bot 命令

### 基础命令

| 命令 | 说明 | 依赖账号级下载器 |
| :--- | :--- | :---: |
| `/start` | 身份认证 / 开始使用 | 否 |
| `/help` | 查看 Bot 内置帮助 | 否 |
| `/list [数量] [页码]` | 查看最近文件和可复制的文件 ID | 否 |
| `/setup_2fa` | 配置双重验证 (TOTP) | 否 |
| `/storage` | 查看存储状态；可在二次确认后删除本地实体文件 | 否 |
| `/tasks` | 查看实时传输任务队列 | 否 |
| `/task_pause [任务ID]` | 暂停当前聊天的普通下载，或暂停指定任务的新下载 | 否 |
| `/task_resume [任务ID]` | 继续当前聊天的普通下载，或继续指定任务 | 否 |
| `/task_cancel <任务ID或all>` | 取消指定任务，或经确认取消当前聊天全部任务 | 否 |
| `/stop_tasks` | 经确认取消当前聊天全部任务；别名 `/stop`、`/cancel_tasks` | 否 |
| `/download_workers` | 设置单文件分片并发；别名 `/workers` | 否 |
| `/file_concurrency` | 设置一次同时下载几个文件；别名 `/file_workers`、`/download_files` | 否 |
| `/duplicate_mode` | 设置重复文件处理；别名 `/duplicate`、`/dup` | 否 |
| `/cleanup_settings` | 设置“自动清理未登记到文件索引的本地临时文件”开关；别名 `/cleanup` | 否 |
| `/ytdlp <url>` | 解析并下载视频链接到当前存储源 | 否 |
| `/delete <至少 8 位 ID 前缀>` | 删除指定文件；ID 可从 `/list` 或 Web 预览复制 | 否 |

> “清理”相关操作按对象区分：Web 设置中的“删除任务历史”只删 Telegram 下载审计明细；`/cleanup_settings` 只管理未索引临时文件的自动清理；`/storage` 中的危险操作会删除本地实体文件，必须单独确认。

### 保存位置命令

| 命令 | 说明 |
| :--- | :--- |
| `/path_rules` | 打开保存位置 / 自定义目录面板；别名 `/path`、`/save_rules` |
| `/p <目录>` | 仅下一次下载保存到指定目录 |
| `/ps <目录>` | 当前会话持续保存到指定目录 |
| `/pc` | 清除下一次 / 本会话自定义目录 |

默认未设置自定义目录时，文件会自动按来源/频道和文件类型归档；设置自定义目录后，文件直接保存到指定目录，不再追加频道名或类型目录。

### 频道/群组转存与订阅命令

这些命令需要账号级 Telegram 下载器：

| 命令 | 说明 |
| :--- | :--- |
| `/tg_download` | 打开按日期 / 标签下载向导；别名 `/tg_dl` |
| `/tg_download date <频道> <开始日期> <结束日期>` | 按日期范围抓取媒体，例如 `/tg_download date @channel 2026-01-01 2026-01-31` |
| `/tg_download tag <频道> <#标签>` | 按标签抓取媒体，例如 `/tg_download tag @channel #壁纸` |
| `/tg_sub` | 打开订阅管理向导；别名 `/tg_subscribe` |
| `/tg_sub <频道>` | 添加频道/群组订阅 |
| `/tg_subs` | 查看订阅列表；别名 `/tg_subscriptions` |
| `/tg_unsub <频道或订阅ID前缀>` | 取消订阅；别名 `/tg_unsubscribe` |
| `/tg_retry [数量] [任务ID]` | 重试最近失败的 Telegram 下载任务 |

兼容旧命令：`/tg_date` 和 `/tg_tag` 仍可用，但 README 推荐统一使用 `/tg_download date` / `/tg_download tag`。

> 多文件上传数量达到 9 个及以上时，Bot 会自动进入静默排队模式，避免刷屏；可随时用 `/tasks` 查看进度。

---

## 📥 yt-dlp 视频下载

通过集成 [yt-dlp](https://github.com/yt-dlp/yt-dlp)，你可以直接在 Telegram Bot 中发送视频链接，让服务器解析并下载到当前存储源。

```text
/ytdlp https://example.com/video
```

限制：仅支持单个链接；需要先通过 `/start` 验证身份；链接必须以 `http://` 或 `https://` 开头。

---

## 🔐 安全与访问控制

TG Vault 默认采用“首次初始化”模式保护 Web 和 API：

1. 服务启动后，首次访问 Web 页面会要求创建：
   - 网页管理员密码：至少 8 位，使用 `scrypt` 加盐哈希后保存到数据库。
   - Telegram Bot 4 位 PIN：仅用于 Bot `/start` 身份验证，同样使用 `scrypt` 加盐哈希保存。
2. 登录成功后，浏览器会获得 HttpOnly Cookie 会话，前端不再把访问 token 写入 `localStorage`。
3. 修改类请求会校验 `Origin`，请确保 `.env` 中的 `CORS_ORIGIN` 与前端公网地址一致。

> [!IMPORTANT]
> 生产环境请使用 HTTPS。默认 `COOKIE_SECURE=true` 时，浏览器只会在 HTTPS 下发送登录 Cookie；如果你只在本地 HTTP 调试，可临时设置 `COOKIE_SECURE=false`。

### 自动密钥说明

TG Vault 会在首次启动时自动生成内部密钥，并保存到 Docker 数据卷的 `/data/secrets/` 目录中。正常部署无需手动配置。迁移服务器时请连同 Docker volume 一起备份，否则登录会话、TOTP 密钥和已加密的第三方存储凭证可能需要重新配置。

完整的宿主机 Nginx 部署、健康检查、协调备份与隔离恢复校验流程见 [`deploy/DEPLOY.md`](deploy/DEPLOY.md)。仓库提供 `deploy/backup.sh` 和只读归档检查脚本 `deploy/restore-verify.sh`；备份包含密钥材料，必须加密并异地保存。

### 双重验证 (TOTP)

TG Vault 内置支持 TOTP 双重验证（如 Google Authenticator）：

- Web 端：在个人设置中扫码激活
- Telegram Bot：发送 `/setup_2fa` 获取设置二维码，并在对话框输入验证码激活
- 启用后，网页登录和使用 Bot 均需二次验证

---

## 🌐 反向代理建议

如果你使用 Nginx、Nginx Proxy Manager 或 Caddy 部署，请参考以下映射：

| 访问域名 | 协议 | 转发至宿主机 IP:端口 | 说明 |
| :--- | :--- | :--- | :--- |
| `cloud.example.com` | HTTPS | `127.0.0.1:47832` | 前端 / 网页入口 |
| `api.example.com` | HTTPS | `127.0.0.1:51947` | 后端 / API 接口 |

如果前后端使用不同域名，请在后端环境变量中设置：

```env
VITE_API_URL=https://api.example.com
CORS_ORIGIN=https://cloud.example.com
COOKIE_SECURE=true
```

> [!CAUTION]
> 开启 HTTPS 后，`.env` 中的 `VITE_API_URL` 和 `CORS_ORIGIN` 都应使用 `https://`，否则浏览器可能拦截请求。修改 `VITE_API_URL` 后必须重新构建前端镜像，因为它会被打包进静态文件。

---

## 🔄 维护与更新

如果已经按本 README 用 Docker Compose 部署，后续想让服务器和 GitHub `main` 分支保持同步，请先进入你实际部署的项目目录（也就是包含 `docker-compose.yml` 的目录），然后执行下面命令。默认会同时更新前端和后端：

```bash
git fetch origin
git pull --ff-only origin main

docker compose up -d --build
```

说明：

- `docker compose up -d --build` 会按最新代码重新构建并启动前后端容器。
- PostgreSQL 数据、上传文件、Telegram 用户 session 和内部密钥都在 Docker volume 中，正常重建容器不会丢失。
- 如果你修改了 `.env` 中的 `VITE_API_URL`，也使用同一套更新命令；前端会重新打包新的 API 地址。
- 如果 `git pull --ff-only` 提示本地有改动，请先用 `git status --short` 查看；确认要临时保存本地改动时可执行：

```bash
git stash push -u -m "before update"
git pull --ff-only origin main
docker compose up -d --build
```

清理无用 Docker 资源：

```bash
docker system prune -f
```

---

## 📂 项目结构

```text
TG Vault/
├── frontend/           # React 网页前端
├── backend/            # Node.js API 与 Telegram 服务
├── init.sql            # 数据库初始化脚本
├── docker-compose.yml  # Docker Compose 部署配置
├── .env.example        # 环境变量模板
└── LICENSE             # MIT License
```

---

## 📄 开源协议

基于 [MIT License](LICENSE) 开源。

---

[![Star History Chart](https://api.star-history.com/svg?repos=hicocos/tg-vault&type=date&legend=top-left)](https://www.star-history.com/#hicocos/tg-vault&type=date&legend=top-left)
