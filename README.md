# ☁️ FoomClous

**FoomClous** 是一款高性能、极简主义的个人私有云存储解决方案。支持大文件切片上传、实时图片预览、视频流播放，并提供强大的 API 支持（如 Telegram Bot 集成）。

---

## 🚀 快速部署 (Docker Compose)

这是最简单、最推荐的方式。

### 1. 克隆仓库
```bash
git clone https://github.com/nccttc/foomclous.git
cd foomclous
```

### 2. 配置环境变量
```bash
cp .env.example .env
vi .env  # 修改 DB_PASSWORD, CORS_ORIGIN 等
```

### 3. 构建并启动 (⚠️ 重要)

由于 `VITE_API_URL` 是**构建时**变量，你需要在构建前端镜像时指定你的 API 地址：

```bash
# 构建前端 (将 YOUR_API_URL 替换为你的实际地址)
docker build --build-arg VITE_API_URL=https://your-api.example.com -t foomclous-frontend ./frontend

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

## 🔐 安全与访问控制

如果设置了 `ACCESS_PASSWORD_HASH`，访问网页和 API 将需要输入密码。本应用目前使用 **SHA-256** 算法进行哈希。

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

## ✨ 功能特性

*   📦 **极速上传**: 支持大文件切片、断点续传。
*   🖼️ **智能预览**: 图片自动缩略图（WebP）、视频实时流播放。
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

## 📄 开源协议

基于 [MIT License](LICENSE) 开源。欢迎提交 Pull Request 贡献代码！
