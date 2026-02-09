# ☁️ FoomClous

**FoomClous** 是一款高性能、极简主义的个人私有云存储解决方案。支持大文件切片上传、实时图片预览、视频流播放，并提供强大的 API 支持（如 Telegram Bot 集成）。

---

## 🚀 快速部署 (Docker Compose)

这是最简单、最推荐的方式。只需两步即可在服务器上启动完整服务。

### 1. 下载配置文件
在服务器上创建一个目录并进入，下载部署所需的 `docker-compose.yml`：

```bash
mkdir foomclous && cd foomclous
wget https://raw.githubusercontent.com/nccttc/foomclous/main/docker-compose.prod.yml -O docker-compose.yml
```

### 2. 配置并运行
下载 `.env.example` 并重命名为 `.env`，然后根据实际情况修改配置：

```bash
wget https://raw.githubusercontent.com/nccttc/foomclous/main/.env.example -O .env

# 编辑 .env 文件
# vi .env

# 启动服务
docker-compose up -d
```

---

## 🛠️ 环境变量配置

在启动前，请确保设置好以下核心变量（建议放入 `.env` 文件）：

| 变量名 | 说明 | 示例 |
| :--- | :--- | :--- |
| `VITE_API_URL` | 前端访问后端的地址 (域名或 IP:端口) | `https://api.yourdomain.com` |
| `DB_PASSWORD` | 数据库密码 | `mypassword123` |
| `CORS_ORIGIN` | 允许跨域的来源 | `https://cloud.yourdomain.com` |
| `DOMAIN` | 应用域名 | `yourdomain.com` |
| `ACCESS_PASSWORD_HASH` | (可选) 访问密码的 Hash | `argon2_hash_here...` |
| `TELEGRAM_BOT_TOKEN` | (可选) Telegram Bot Token | `123456:ABC-DEF...` |
| `TELEGRAM_API_ID` | (可选) Telegram API ID | `123456` |
| `TELEGRAM_API_HASH` | (可选) Telegram API Hash | `abcdef123456...` |

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

如果你希望手动运行镜像，可以使用以下 Docker Hub 官方镜像：

*   **后端 API:** `cxaryoro/foomclous-backend:latest`
*   **前端 UI:** `cxaryoro/foomclous-frontend:latest`
*   **数据库:** `postgres:16-alpine`

### 手动单条命令启动示例 (快速测试)

```bash
# 1. 启动数据库
docker run -d --name fc-db -e POSTGRES_PASSWORD=pass postgres:16-alpine

# 2. 启动后端
docker run -d --name fc-api \
  -e DATABASE_URL=postgresql://foomclous:pass@fc-db:5432/foomclous \
  -p 51947:51947 \
  --link fc-db:fc-db \
  cxaryoro/foomclous-backend:latest
```

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
