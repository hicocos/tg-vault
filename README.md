<div align="center">
  <img src="backend/logo.png" alt="TG Vault Logo" width="150" />

  <h1>TG Vault</h1>

  <p>
    <strong>把 Telegram 变成你的自动化私有云入口</strong>
  </p>
  <p>
    面向个人与小团队的 Telegram 转存、媒体归档和多存储源文件管理系统。
  </p>

  <p>
    <a href="#-快速部署-docker-compose"><strong>快速部署</strong></a>
    ·
    <a href="#-功能概览"><strong>功能概览</strong></a>
    ·
    <a href="#-telegram-bot-命令"><strong>Bot 命令</strong></a>
    ·
    <a href="deploy/DEPLOY.md"><strong>生产部署</strong></a>
  </p>

  <p>
    <a href="https://github.com/hicocos/tg-vault/releases"><img src="https://img.shields.io/github/v/release/hicocos/tg-vault?style=for-the-badge&logo=github&color=2f81f7" alt="Latest Release" /></a>
    <a href="https://github.com/hicocos/tg-vault/blob/main/LICENSE"><img src="https://img.shields.io/github/license/hicocos/tg-vault?style=for-the-badge&color=00b894" alt="License" /></a>
    <a href="https://github.com/hicocos/tg-vault/stargazers"><img src="https://img.shields.io/github/stars/hicocos/tg-vault?style=for-the-badge&logo=github&color=f1c40f" alt="Stars" /></a>
    <a href="https://github.com/hicocos/tg-vault/network/members"><img src="https://img.shields.io/github/forks/hicocos/tg-vault?style=for-the-badge&logo=github&color=8e44ad" alt="Forks" /></a>
  </p>
  <p>
    <img src="https://img.shields.io/badge/Release-v2.4.2-2ea44f?style=flat-square" alt="Release v2.4.2" />
    <img src="https://img.shields.io/badge/Telegram-Bot-26A5E4?style=flat-square&logo=telegram&logoColor=white" alt="Telegram Bot" />
    <img src="https://img.shields.io/badge/Docker-Compose-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker Compose" />
    <img src="https://img.shields.io/badge/React-TypeScript-3178C6?style=flat-square&logo=react&logoColor=white" alt="React TypeScript" />
    <img src="https://img.shields.io/badge/PostgreSQL-16-4169E1?style=flat-square&logo=postgresql&logoColor=white" alt="PostgreSQL 16" />
  </p>
</div>

> [!TIP]
> **一条链路完成收集、转存、归档与管理：** 从 Telegram 私聊、频道/群组或视频链接接收内容，自动写入本地磁盘、OneDrive、Google Drive、OSS、S3 或 WebDAV，再通过 Web 控制台统一管理。

---

## ✨ 功能概览

- **Web 管理** — 文件上传、分片大文件上传、文件夹、预览、删除和存储源管理
- **多存储源** — 本地、OneDrive、Google Drive、阿里云 OSS、S3 兼容存储和 WebDAV
- **账号级下载器** — 频道/群组按日期或标签批量抓取、订阅同步和更稳定的大文件下载
- **自动归档** — 默认按来源、频道和文件类型保存，例如 `telegram/channel/images/file.jpg`
- **安全防护** — 首次初始化管理员、HttpOnly Cookie、Origin 校验、签名 URL 和 TOTP 双重验证


---

## 🚀 快速部署 (Docker Compose)

### 1. 克隆仓库

```bash
git clone https://github.com/hicocos/tg-vault.git
cd tg-vault
```

### 2. 运行安装向导

```bash
./deploy/install.sh
```

安装向导会先检测 Docker Engine、Docker Compose 插件、Python 3 和 Git；缺少组件时，由你选择自动补全、查看手动提示或退出。首次安装只需要输入 Web 前端 URL 和后端 API URL，确认后脚本会生成 `.env`、数据库密码和应用密钥，并构建启动服务。升级已有部署时，脚本会识别已有配置，直接按提示保留原地址，不会重建 PostgreSQL 或覆盖持久化数据。

- **基础 Web 部署**
  只需输入 Web 前端 URL 与后端 API URL；地址必须是完整的 `http(s)` origin。
- **启用 Telegram Bot 基础能力**
  首次打开 Web 并完成管理员初始化后，进入 **设置 → Telegram → Telegram Bot 连接**，填写 Bot Token、API ID、API Hash 和 Bot PIN。凭证会加密保存且不回显；不要把这些内容写入 `.env`。
- **启用账号级 Telegram 下载器**
  只有需要频道/群组批量抓取、订阅同步或更稳定的大文件下载时，才在 **设置 → Telegram → Telegram 账号下载器** 中登录。session 加密保存在服务端。

> [!IMPORTANT]
> `VITE_API_URL` 会打包进前端静态文件。修改该地址后必须重新运行 `deploy/install.sh`；仅重启容器不会更新 API 地址。

---

## 🛠️ 环境变量配置

> 下面仅列出部署时最常用的变量。点击各分组展开详情；完整模板以 [`.env.example`](.env.example) 为准。

<details open>
<summary><strong>新手只需填写（2 项）</strong></summary>

- **`VITE_API_URL`** — 前端访问后端的公网地址；示例：`https://api.yourdomain.com`
- **`CORS_ORIGIN`** — 允许跨域的前端来源；示例：`https://cloud.yourdomain.com`

> 两项都必须是完整的 `http(s)` origin，不要带路径、查询参数或末尾 `/`。安装向导会直接询问并校验这两个地址，无需手动编辑 `.env` 或重复运行脚本。

</details>

<details>
<summary><strong>安装脚本自动生成</strong></summary>

- **`DB_PASSWORD`** — 自动生成 64 位十六进制 PostgreSQL 密码
- **`SESSION_SECRET`** / **`STORAGE_CREDENTIALS_SECRET`** — 新安装时自动生成并保留；升级旧部署时不会覆盖 `/data/secrets` 中已有的持久密钥

版本号不保存在 `.env`。安装时会直接从 `backend/package.json` 读取应用版本，并从当前 Git 提交读取源码修订号，只把它们临时传给 Docker 构建。

</details>

<details>
<summary><strong>高级部署覆盖</strong></summary>

- **`OAUTH_CALLBACK_BASE_URL`** — 默认继承 `VITE_API_URL`；仅特殊 API 入口时填写
- **`OAUTH_FRONTEND_ORIGIN`** — 默认继承 `CORS_ORIGIN` 的第一个地址；仅多前端入口时填写

</details>

<details>
<summary><strong>Telegram 配置原则</strong></summary>

Telegram 凭证、允许用户、账号登录、来源白名单和下载并发均属于运行配置，统一在 Web **设置 → Telegram** 中管理。新部署不需要在 `.env` 中填写 Telegram 变量，也不需要手动生成 session 文件。

旧版本 `.env` 变量仍会被兼容读取，但只用于升级和迁移；不要在新部署中同时维护两套配置。Web 中的设置优先于环境变量。

</details>

<details>
<summary><strong>常用可选项（9 项）</strong></summary>

- **`PORT`** `51947` — 后端监听端口
- **`UPLOAD_DIR`** `/data/uploads` · **`THUMBNAIL_DIR`** `/data/thumbnails` · **`CHUNK_DIR`** `/data/chunks`
- **`DUPLICATE_FILE_MODE`** `copy` — `copy` 生成副本；`skip` 跳过同名、同目录且同大小的文件
- **`AUTO_CLEANUP_ORPHANS`** `true` — 自动清理未登记到数据库的本地孤儿文件

</details>

<details>
<summary><strong>限流与安全项（10 项）</strong></summary>

- **普通消息限流** — `TELEGRAM_RATE_WINDOW_MS=60000`，`TELEGRAM_RATE_MAX=30`
- **重型命令限流** — `TELEGRAM_HEAVY_RATE_WINDOW_MS=600000`，`TELEGRAM_HEAVY_RATE_MAX=5`
- **`TRUST_PROXY`** `loopback` · **`COOKIE_SECURE`** `true` · **`JSON_BODY_LIMIT`** `2mb`
- **分片限制** — `MAX_UPLOAD_CHUNK_MB=32`，`MAX_CHUNK_UPLOAD_GB=20`，`CHUNK_GLOBAL_BUDGET_GB=40`
- **磁盘与数量保护** — `CHUNK_DISK_RESERVE_GB=8`，`MAX_TOTAL_CHUNKS=50000`
- **`ORPHAN_CLEANUP_MIN_AGE_MS`** `600000` — 10 分钟内不清理本地孤儿文件

</details>

---

## 🤖 Telegram 配置与能力

### Bot 与账号级下载器的区别

**只启用 Bot 即可使用：**

- ✅ 私聊发送文件给 Bot 转存
- ✅ 任务管理、存储统计和删除文件

**额外启用账号级下载器后增加：**

- ✅ 频道/群组按日期或标签批量抓取
- ✅ 频道订阅自动同步
- ✅ 更稳定地下载超过 Bot 限制的大文件

### 获取 Bot Token

1. 在 Telegram 中搜索 [@BotFather](https://t.me/BotFather) 并开始对话。
2. 发送 `/newbot`，按提示创建机器人。
3. 复制 BotFather 返回的 `HTTP API TOKEN`。
4. 在 TG Vault Web 的“设置 → Telegram”中填写 Token。

### 获取 API ID 和 API Hash

1. 访问 [my.telegram.org](https://my.telegram.org) 并登录 Telegram 账号。
2. 进入 `API development tools`。
3. 创建应用后复制 `api_id` 和 `api_hash`。
4. 在 **设置 → Telegram → Telegram Bot 连接** 中与 Bot Token 一起填写，先测试连接，再保存并启用。
5. 需要账号级下载器时，在同页使用手机号、验证码和可选两步验证密码登录；无需手工生成或编辑 session 文件。

### Telegram Bot 允许用户

TG Vault 会限制能通过 Bot PIN 登录的 Telegram 用户。推荐进入 **设置 → Telegram → Telegram Bot 用户权限**，填写一个或多个数字 user id；多个 ID 用英文逗号分隔。

获取 user id：让用户在 Telegram 私聊 `@userinfobot` 查看 `Id`。如果允许列表留空，并且后台还没有任何 Telegram 用户认证成功，第一个正确输入 Bot PIN 的用户可自动加入允许列表。之后应在 Web 中明确维护列表。

旧部署仍可使用 `TELEGRAM_ALLOWED_USER_IDS` 环境变量；一旦设置，Web 页面会显示“由环境变量管理”，需要修改 `.env` 并重启 backend。

### 账号级下载器什么时候需要？

账号级下载器会用你登录的 Telegram 用户账号读取媒体。只有下面这些场景建议启用：

- 频道/群组转存：用户账号需要加入对应频道/群组，并确保能看到历史媒体。
- 按日期/标签批量抓取：`/tg_download date`、`/tg_download tag` 依赖用户账号访问来源消息。
- 频道订阅同步：`/tg_sub` 后台扫描依赖用户账号读取频道/群组新消息。
- 大文件下载：Bot 直接下载受 Telegram Bot 限制影响，账号级下载器通常更稳定。

### Telegram 下载设置

下载并发等参数不属于首次部署配置。需要调整时，在 Web **设置 → 维护 → 高级任务设置** 中修改；页面会显示当前值、适用范围和高风险确认，不建议新手编辑 `.env` 或凭经验修改并发数。

---

## 🧭 Telegram Bot 命令

<details open>
<summary><strong>常用命令</strong></summary>

- `/start` 认证 · `/help` 帮助 · `/list [数量] [页码]` 最近文件
- `/delete <至少 8 位 ID 前缀>` 删除文件 · `/setup_2fa` 配置 TOTP

</details>

<details>
<summary><strong>任务、下载与清理设置</strong></summary>

- **任务控制** — `/task_pause [任务ID]` · `/task_resume [任务ID]` · `/task_cancel <任务ID或all>` · `/stop_tasks`
- **并发设置** — `/download_workers`（别名 `/workers`）· `/file_concurrency`（别名 `/file_workers`、`/download_files`）
- **文件策略** — `/duplicate_mode`（别名 `/duplicate`、`/dup`）· `/cleanup_settings`（别名 `/cleanup`）

> Web 设置中的“删除任务历史”、`/cleanup_settings` 管理的临时文件清理，以及 `/storage` 中删除本地实体文件，是三类不同操作；危险操作均需单独确认。

</details>

<details>
<summary><strong>保存位置命令</strong></summary>

- `/path_rules` — 打开保存位置面板；别名 `/path`、`/save_rules`
- `/p <目录>` — 仅下一次下载使用该目录
- `/ps <目录>` — 当前会话持续使用该目录
- `/pc` — 清除下一次 / 本会话自定义目录

未设置时按来源、频道和文件类型自动归档；设置后直接保存到指定目录。

</details>

<details>
<summary><strong>频道/群组转存与订阅（需要账号级下载器）</strong></summary>

- `/tg_download` — 打开按日期 / 标签下载向导；别名 `/tg_dl`
- `/tg_download date <频道> <开始日期> <结束日期>` — 按日期范围抓取
- `/tg_download tag <频道> <#标签>` — 按标签抓取
- `/tg_retry [数量] [任务ID]` — 重试失败任务
- `/tg_sub <频道>` · `/tg_subs` · `/tg_unsub <频道或订阅ID前缀>` — 添加、查看和取消订阅

兼容旧命令 `/tg_date`、`/tg_tag`。多文件达到 9 个及以上时自动静默排队，可用 `/tasks` 查看进度。

</details>

---

## 🔐 安全与访问控制

TG Vault 默认采用“首次初始化”模式保护 Web 和 API：

1. 服务启动后，首次访问 Web 页面始终创建至少 8 位的网页管理员密码，并使用 `scrypt` 加盐哈希保存到数据库。
2. 如果此时已经通过环境变量配置 Telegram Bot，初始化页还会要求创建 Bot 4 位 PIN；新安装也可以先完成网页初始化，再到 **设置 → Telegram** 配置 Bot 和 PIN。
3. 登录成功后，浏览器会获得 HttpOnly Cookie 会话，前端不再把访问 token 写入 `localStorage`。
4. 修改类请求会校验 `Origin`，请确保 `.env` 中的 `CORS_ORIGIN` 与前端公网地址一致。

> [!IMPORTANT]
> 生产环境请使用 HTTPS。默认 `COOKIE_SECURE=true` 时，浏览器只会在 HTTPS 下发送登录 Cookie；如果你只在本地 HTTP 调试，可临时设置 `COOKIE_SECURE=false`。
> `deploy/install.sh` 生成的正式部署会额外写入 `COOKIE_SECURE_FORCE=true`，防止遗留环境值意外关闭 HTTPS Cookie；本地 HTTP 调试请不要沿用该强制值，或同时设为 `false`。

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

- **前端 / 网页入口**
  - 示例域名：`https://cloud.example.com`
  - 转发地址：`127.0.0.1:47832`
- **后端 / API 接口**
  - 示例域名：`https://api.example.com`
  - 转发地址：`127.0.0.1:51947`

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

如果已经按本 README 用 Docker Compose 部署，后续想让服务器和 GitHub `main` 分支保持同步，请先进入实际部署目录（包含 `docker-compose.yml` 的目录），然后执行下面命令：

```bash
git fetch origin
git status --short
git pull --ff-only origin main
./deploy/install.sh
```

说明：

- **首次部署**：运行 `./deploy/install.sh`，按提示填写两个公网地址；不要先复制一堆 Telegram 配置。
- **后续升级**：先看 `git status --short`，确认没有未提交的本地修改，再 `git pull --ff-only origin main`；运行安装向导时已有地址会显示为当前值，按 Enter 保留即可。
- 升级脚本只重建并替换 `backend`、`frontend`，不会重建 PostgreSQL；数据库、上传文件、内部密钥和 Web 中保存的 Telegram 配置位于持久化卷中。
- 如果安装向导检测到地址变化，不要直接确认；输入 `e` 返回重新编辑，确认无误后再开始构建。

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

## 📊 项目数据

<div align="center">
  <a href="https://github.com/hicocos">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://github-stats-extended.vercel.app/api?username=hicocos&amp;show_icons=true&amp;include_all_commits=true&amp;rank_icon=github&amp;locale=cn&amp;theme=github_dark&amp;hide_border=true&amp;cache_seconds=21600" />
      <img height="195" alt="hicocos 的 GitHub 统计" src="https://github-stats-extended.vercel.app/api?username=hicocos&amp;show_icons=true&amp;include_all_commits=true&amp;rank_icon=github&amp;locale=cn&amp;theme=default&amp;hide_border=true&amp;cache_seconds=21600" />
    </picture>
  </a>
  <a href="https://github.com/hicocos/tg-vault">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://github-stats-extended.vercel.app/api/top-langs/?username=hicocos&amp;layout=compact&amp;langs_count=8&amp;theme=github_dark&amp;hide_border=true&amp;cache_seconds=21600" />
      <img height="195" alt="hicocos 的常用语言" src="https://github-stats-extended.vercel.app/api/top-langs/?username=hicocos&amp;layout=compact&amp;langs_count=8&amp;theme=default&amp;hide_border=true&amp;cache_seconds=21600" />
    </picture>
  </a>
</div>

<p align="center">
  <sub>统计卡片由 <a href="https://github.com/stats-organization/github-stats-extended">GitHub Stats Extended</a> 动态生成，并随 GitHub 明暗主题自动切换。</sub>
</p>

<div align="center">
  <a href="https://www.star-history.com/#hicocos/tg-vault&amp;type=date&amp;legend=top-left">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=hicocos/tg-vault&amp;type=date&amp;legend=top-left&amp;theme=dark" />
      <img alt="TG Vault Star History Chart" src="https://api.star-history.com/svg?repos=hicocos/tg-vault&amp;type=date&amp;legend=top-left" />
    </picture>
  </a>
</div>
