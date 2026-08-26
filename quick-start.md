---
title: 快速部署
description: 用安装脚本和 Docker Compose 快速部署 TG Vault
---

{% include nav.html %}

# 快速部署

TG Vault 的正式部署包含三个容器：`frontend`、`backend` 和 `postgres`。宿主机上的 Nginx、Caddy、宝塔面板或其他反向代理负责域名与 HTTPS；Compose 不包含 Nginx 或 Certbot。

## 最短部署流程

```bash
git clone https://github.com/hicocos/tg-vault.git
cd tg-vault
chmod +x deploy/install.sh
./deploy/install.sh
```

第一次运行会安全创建 `.env`、数据库密码、应用密钥和构建版本信息。由于新文件内仍是示例域名，脚本会提示修改地址并停止，这是正常行为。

编辑 `.env`，新手只需修改两项：

```dotenv
VITE_API_URL=https://api.example.com
CORS_ORIGIN=https://cloud.example.com
```

- `VITE_API_URL`：浏览器访问后端 API 的公网地址。
- `CORS_ORIGIN`：Web 前端的公网地址。
- 两项都应是完整的 HTTP(S) origin，不带路径、查询参数、片段或末尾 `/`；生产环境请使用 HTTPS。

保存后再次运行：

```bash
./deploy/install.sh
```

脚本会校验配置，执行 `docker compose up -d --build`，然后显示容器状态。Telegram 不需要写入 `.env` 才能完成基础部署；推荐在 Web 启动后配置。

## 1. 准备条件

- 一台安装了 Docker Engine、Docker Compose 插件、Git、OpenSSL 和 Python 3 的 Linux 服务器
- Web 域名，例如 `cloud.example.com`
- API 域名，例如 `api.example.com`
- 两个域名都已解析到服务器，并可配置 HTTPS

默认端口仅绑定宿主机回环地址：

| 服务 | 宿主机地址 |
| --- | --- |
| Web 前端 | `127.0.0.1:47832` |
| 后端 API | `127.0.0.1:51947` |

## 2. 安装脚本会做什么

`deploy/install.sh` 会：

1. 检查 Docker、OpenSSL 和项目目录。
2. 首次创建权限为 `600` 的 `.env`。
3. 生成并保留 `DB_PASSWORD`；新安装还会生成 `SESSION_SECRET` 和 `STORAGE_CREDENTIALS_SECRET`。
4. 写入当前源码的 `SOURCE_REVISION`、`SOURCE_VERSION` 和 `IMAGE_VERSION`。
5. 校验 Web/API 地址并运行 Compose。

已有部署升级时，脚本不会突然用新值覆盖 `/data/secrets` 中已有的持久密钥，避免现有 2FA 与存储凭据失效。

OAuth 默认继承这两项：

```text
OAUTH_CALLBACK_BASE_URL ← VITE_API_URL
OAUTH_FRONTEND_ORIGIN   ← CORS_ORIGIN
```

只有多入口或特殊反向代理部署才需要显式覆盖它们。完整变量以仓库的 [`.env.example`](https://github.com/hicocos/tg-vault/blob/main/.env.example) 为准。

## 3. 不使用脚本时手动启动

推荐优先使用安装脚本。如果需要手动管理 Compose，至少先创建 `.env` 并生成数据库密码：

```bash
cp .env.example .env
openssl rand -hex 32
# 将输出填入 .env 的 DB_PASSWORD，并填写 VITE_API_URL、CORS_ORIGIN

docker compose config --quiet
docker compose up -d --build
docker compose ps
```

缺失构建元数据时，镜像标签/版本会回退为 `source`、`unknown` 或 `worktree`。`VITE_API_URL` 会在构建时写入前端；修改后必须重新构建，只重启容器不会更新静态文件中的 API 地址。

## 4. 配置反向代理

推荐使用两个 HTTPS 域名：

- `https://cloud.example.com` → `http://127.0.0.1:47832`
- `https://api.example.com` → `http://127.0.0.1:51947`

仓库提供可修改的 [Nginx 示例](https://github.com/hicocos/tg-vault/blob/main/deploy/nginx-site.conf)。上传链路应关闭请求缓冲、放宽请求体限制，并为大文件设置足够长的读写超时。TLS 证书由宿主机反向代理或面板管理，不要运行 `docker compose run certbot`。

OAuth 平台登记的回调地址必须精确匹配：

```text
https://api.example.com/api/storage/onedrive/callback
https://api.example.com/api/storage/google-drive/callback
```

## 5. 首次打开 Web

访问 Web 域名，首次初始化只要求创建至少 8 位的网页管理员密码。登录使用 HttpOnly Cookie。

推荐随后进入 **设置 → Telegram** 配置 Bot：

1. 填写 Bot Token、API ID、API Hash 和 4 位 Bot PIN。
2. 点击 **测试连接**。
3. 点击 **保存并启用**。
4. 在 **Telegram Bot 用户权限** 中维护允许用户 ID。
5. 如需频道/群组抓取，再在同页使用手机号、验证码和可选两步验证密码登录账号级下载器。

如果旧部署已在 `.env` 中配置 Telegram 凭据，首次初始化可能仍要求创建 Bot PIN；登录后可在设置页迁移到网页加密管理。

## 6. 验证部署

```bash
docker compose ps
curl -fsS http://127.0.0.1:51947/livez
curl -fsS http://127.0.0.1:51947/readyz
curl -I http://127.0.0.1:47832/
```

- `/livez`：后端进程存活。
- `/readyz`：数据库、存储、安全密钥和配置为必需的 Telegram 组件已就绪。
- Telegram 默认是可选组件；未配置或故障不会阻断 Web/API。旧部署可用 `TELEGRAM_REQUIRED=true` 改为严格就绪检查。

出现异常时查看：

```bash
docker compose logs --tail=150 backend frontend postgres
```

## 7. 更新

先确认工作区没有未处理的本地修改，再更新并重新运行安装脚本：

```bash
git fetch origin
git status --short
git pull --ff-only origin main
./deploy/install.sh
```

安装脚本会刷新版本元数据并构建、启动服务。不要用强制拉取覆盖未确认的本地改动。

## 下一步

- [配置 Telegram Bot 与账号级下载器](./telegram.html)
- [配置存储源](./storage.html)
- [使用 Web 或 Bot 创建 yt-dlp 任务](./ytdlp.html)
- [生产运维、备份与恢复](./operations.html)
- [安全说明](./security.html)
