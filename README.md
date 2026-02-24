<p align="center">
  <img src="backend/logo.png" alt="FoomClous Logo" width="150" />
</p>

<h1 align="center"> FoomClous</h1>

<p align="center">
  <img src="https://img.shields.io/github/license/nccttc/foomclous?style=flat-square&color=blue" alt="License" />
  <img src="https://img.shields.io/github/stars/nccttc/foomclous?style=flat-square&color=gold" alt="Stars" />
  <img src="https://img.shields.io/github/forks/nccttc/foomclous?style=flat-square&color=lightgrey" alt="Forks" />
  <img src="https://img.shields.io/github/issues/nccttc/foomclous?style=flat-square&color=red" alt="Issues" />
  <img src="https://img.shields.io/badge/Security-HDFS--Ready-green?style=flat-square" alt="Security" />
</p>

<p align="center">
  <strong>FoomClous</strong> 是一款高性能、极简主义的个人私有云存储解决方案。支持大文件切片上传、实时图片预览、视频流播放，并提供强大的 API 支持（如 Telegram Bot 集成）。
</p>

---

## 🚀 快速部署 (Docker Compose)

这是最简单、最推荐的方式。

### 1. 克隆仓库
```bash
git clone https://github.com/nccttc/FoomClous.git
mv FoomClous foomclous
cd foomclous
```

### 2. 配置环境变量
```bash
cp .env.example .env
vi .env  # 修改 DB_PASSWORD, CORS_ORIGIN 等
也可进入服务器 /root/foomclous 目录下修改 .env 文件
```

### 3. 构建并启动 (⚠️ 重要)

由于 `VITE_API_URL` 是**构建时**变量，你需要在构建前端镜像时指定你的 API 地址：

```bash
# 构建前端 (将 YOUR_API_URL 替换为你的实际地址)
docker build --build-arg VITE_API_URL=https://cloud.yourdomain.com -t foomclous-frontend ./frontend

# 构建后端
docker build -t foomclous-backend ./backend

# 启动服务
docker compose -f docker-compose.prod.yml up -d
```

> [!IMPORTANT]
> `VITE_API_URL` 必须在 `docker build` 时通过 `--build-arg` 传入，运行时的 `.env` 无法影响它。

---

## 🛠️ 环境变量配置

在启动前，请确保设置好以下核心变量（建议放入 `.env` 文件）：

| 变量名 | 说明 | 示例 |
| :--- | :--- | :--- |
| `VITE_API_URL` | 前端访问后端的地址 (域名或 IP:端口) | `https://api.yourdomain.com` |
| `DB_PASSWORD` | 数据库密码 | `mypassword123` |
| `CORS_ORIGIN` | 允许跨域的来源 | `https://cloud.yourdomain.com` |
| `DOMAIN` | 应用域名 | `yourdomain.com` |
| `ACCESS_PASSWORD_HASH` | (可选) 访问密码的 Hash | `sha256_hash_here...` |
| `TELEGRAM_BOT_TOKEN` | (可选) Telegram Bot Token | `123456:ABC-DEF...` |
| `TELEGRAM_API_ID` | (可选) Telegram API ID | `123456` |
| `TELEGRAM_API_HASH` | (可选) Telegram API Hash | `abcdef123456...` |

---

## 🤖 Telegram Bot 配置指南

集成 Telegram Bot 后，你可以通过聊天窗口直接上传文件、管理云端数据。

### 1. 获取 Bot Token (必选)
1. 在 Telegram 中搜索 [@BotFather](https://t.me/BotFather) 并开始对话。
2. 发送 `/newbot` 命令，按照提示为你的机器人起个名字。
3. 成功后，BotFather 会发给你一串 `HTTP API TOKEN` (例如 `123456:ABC-DEF...`)。
4. 将此 Token 填入 `.env` 的 `TELEGRAM_BOT_TOKEN`。

### 2. 获取 API ID 和 API Hash (可选，增强功能)
*如果你需要使用更高级的 TDLib 或特定接口功能，请按以下步骤操作：*
1. 访问 [my.telegram.org](https://my.telegram.org) 并登录你的 Telegram 账号。
2. 进入 `API development tools`。
3. 创建一个新的应用（App title 和 Short name 可随意填写）。
4. 复制 `App api_id` 和 `App api_hash`。
5. 分别填入 `.env` 的 `TELEGRAM_API_ID` 和 `TELEGRAM_API_HASH`。

---

## 🤖 Telegram Bot 可用命令

配置完成后，你可以向 Bot 发送以下命令：

| 命令 | 描述 |
| :--- | :--- |
| `/start` | 验证身份并开始使用 Bot |
| `/help` | 获取详细帮助信息与使用说明 |
| `/setup_2fa` | 配置或准备双重验证 (TOTP) |
| `/storage` | 查看当前服务器磁盘与存储统计 |
| `/list` | 查看最近上传的文件列表 |
| `/tasks` | 查看当前传输任务队列 (包含下载进度) |
| `/delete <ID>` | 删除指定文件 (支持 ID 前缀) |
| `/ytdlp <url>` | 解析视频链接并下载到存储源 (yt-dlp) |

> [!TIP]
> **多文件上传优化**: 当一次性转发超过 **9** 个文件时，Bot 会自动进入**静默模式**，在后台排队处理以避免刷屏，你可以随时使用 `/tasks` 查看实时进度。

### 📥 视频下载命令 (`/ytdlp`)

通过集成 [yt-dlp](https://github.com/yt-dlp/yt-dlp)，你可以直接在 Telegram Bot 中发送视频链接，让服务器自动解析并下载到当前存储源。

**依赖说明**：
- 官方后端镜像已内置 `yt-dlp` 与 `ffmpeg`，无需额外安装。
- 若自行构建镜像，请确保 Dockerfile 中已安装 `yt-dlp` 可执行文件。

**环境变量**（`.env` 可选）：
| 变量名 | 说明 | 默认值 |
| :--- | :--- | :--- |
| `YTDLP_BIN` | yt-dlp 可执行文件路径 | `yt-dlp`（使用系统 PATH） |
| `YTDLP_WORK_DIR` | 下载临时目录 | `./data/uploads/ytdlp` |
| `YTDLP_MAX_CONCURRENT` | 并发下载任务数 | `1` |

**使用方法**：
1. 在 Telegram 私聊中向 Bot 发送：
   ```
   /ytdlp https://example.com/video
   ```
2. Bot 会回复“开始解析并下载…”表示任务已创建。
3. 下载完成后自动上传到当前存储源，并回复：
   - ✅ 成功：`已上传
文件: xxx.mp4
大小: 12.5 MB
存储源: local`
   - ❌ 失败：`下载/上传失败
原因: ...`

**注意事项**：
- 仅支持单个链接，不支持播放列表。
- 需要已通过 `/start` 验证身份。
- 链接必须以 `http://` 或 `https://` 开头。
- 下载后的文件会自动入库并生成缩略图，在前端 `ytdlp` 文件夹中可见。

---

## 🔐 安全与访问控制

如果设置了 `ACCESS_PASSWORD_HASH`，访问网页和 API 将需要输入密码。本应用目前使用 **SHA-256** 算法进行哈希。

> [!CAUTION]
>注：因TGbot键盘只支持四位数字，所以密码长度限制为四位数字，且不能包含特殊字符，请在生成密码时注意。

### 如何生成密码哈希值？

你可以使用以下任一简单命令生成（将 `your_password` 替换为你想设的密码）：

#### Node.js (推荐，跨平台)
如果你已经安装了 Node.js，直接运行：
```bash
node -e "console.log(require('crypto').createHash('sha256').update('your_password').digest('hex'))"
```

#### Linux/macOS (Git Bash)
```bash
echo -n "your_password" | sha256sum | awk '{print $1}'
```

#### PowerShell (Windows)
```powershell
[System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes("your_password"))).Replace("-", "").ToLower()
```

将生成的 64 位字符串填入 `.env` 文件的 `ACCESS_PASSWORD_HASH` 即可。

### 🔐 双重验证 (Two-Factor Authentication)

FoomClous 已内置支持 TOTP 双重验证（如 Google Authenticator）。
- **Web 端**：在“个人设置”中通过扫码激活。
- **Telegram Bot**：发送 `/setup_2fa` 即可获取设置二维码，直接在对话框输入验证码即可激活。
- **安全性**：启用后，登录网页和使用 Bot 均需二次验证。

---

## 🌐 反向代理建议 (Reverse Proxy)

如果你使用 Nginx 或 NPM 部署，请参考以下映射关系：

| 访问域名 | 协议 | 转发至宿主机 IP:端口 | 说明 |
| :--- | :--- | :--- | :--- |
| `cloud.example.com` | HTTPS | `127.0.0.1:47832` | **前端/网页入口** |
| `api.example.com` | HTTPS | `127.0.0.1:51947` | **后端/API 接口** |

> [!CAUTION]
> 开启 HTTPS 后，`.env` 中的所有 URL 必须以 `https://` 开头，否则浏览器会拦截资源。

## 📦 Docker 镜像说明

> [!WARNING]
> Docker Hub 上的公共前端镜像 (`cxaryoro/foomclous-frontend`) 使用默认 API 地址编译。
> **生产环境请务必使用 `--build-arg VITE_API_URL=...` 自行构建前端镜像。**

后端镜像可以直接使用：
*   **后端 API:** `cxaryoro/foomclous-backend:latest`
*   **数据库:** `postgres:16-alpine`

---

## 🔄 维护与更新

### 1. 更新项目
要获取最新功能的代码并更新服务器，请在项目目录下运行：
```bash
# 进入项目目录
cd /root/foomclous

# 拉取最新代码
git pull origin main

# 重新构建并启动（自动应用改动）
docker compose up -d --build
```

### 2. 清理 Docker 资源
频繁构建可能会占用较多磁盘空间，可以使用以下命令清理废弃的镜像、容器和网络：
```bash
docker system prune -f
```

---

## ✨ 功能特性

*   📦 **极速上传**: 支持大文件切片、断点续传。
*   🖼️ **智能预览**: 图片与视频自动生成缩略图（WebP）、视频实时流播放。
*   🤖 **Bot 友好**: 提供完善的外部 API，轻松集成 Telegram 等机器人。
*   🌍 **多语言**: 内置 i18n 系统，支持中英文切换。
*   🐳 **全容器化**: 一键水平扩展，部署极其简单。

---

## 📂 项目结构

```text
FoomClous/
├── frontend/    # React 网页前端
├── backend/     # Node.js API 服务
├── init.sql     # 数据库初始化脚本
└── docker-compose.prod.yml  # 生产环境部署配置
```

---
[![Star History Chart](https://api.star-history.com/svg?repos=nccttc/FoomClous&type=date&legend=top-left)](https://www.star-history.com/#nccttc/FoomClous&type=date&legend=top-left)

---

---
## 📄 开源协议

基于 [MIT License](LICENSE) 开源。
---
