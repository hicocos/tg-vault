---
title: 快速部署
description: 使用 Docker Compose 部署 TG Vault
---

{% include nav.html %}

# 快速部署

TG Vault 的正式部署由三个容器组成：`frontend`、`backend` 和 `postgres`。宿主机上的 Nginx、Caddy、宝塔面板或其他反向代理负责域名与 HTTPS。

## 1. 准备条件

- 一台安装了 Docker Engine 与 Docker Compose 插件的 Linux 服务器
- 一个 Web 域名，例如 `cloud.example.com`
- 一个 API 域名，例如 `api.example.com`
- 两个域名均已解析到服务器，并可配置 HTTPS

端口默认只监听本机：

| 服务 | 宿主机地址 |
| --- | --- |
| Web 前端 | `127.0.0.1:47832` |
| 后端 API | `127.0.0.1:51947` |

## 2. 获取代码

```bash
git clone https://github.com/hicocos/tg-vault.git
cd tg-vault
cp .env.example .env
```

## 3. 编辑 `.env`

至少检查并填写下面这些值：

```dotenv
DB_PASSWORD=请替换为强随机密码

VITE_API_URL=https://api.example.com
OAUTH_CALLBACK_BASE_URL=https://api.example.com
OAUTH_FRONTEND_ORIGIN=https://cloud.example.com
CORS_ORIGIN=https://cloud.example.com
DOMAIN=cloud.example.com

IMAGE_VERSION=source
SOURCE_REVISION=这里填写 git rev-parse HEAD 的输出
SOURCE_VERSION=这里填写发布标签或 git rev-parse --short HEAD 的输出

COOKIE_SECURE=true
```

可用下面的命令生成数据库密码并读取源码标识：

```bash
openssl rand -hex 32
git rev-parse HEAD
git rev-parse --short HEAD
```

<div class="callout warning">
如果暂时不使用 Telegram，请在 <code>.env</code> 中设置 <code>TELEGRAM_REQUIRED=false</code>。如果设置为 <code>true</code>，Bot 凭据缺失或 Bot 启动失败会使 <code>/readyz</code> 返回 503。
</div>

需要 Telegram 时，再填写：

```dotenv
TELEGRAM_REQUIRED=true
TELEGRAM_BOT_TOKEN=
TELEGRAM_API_ID=
TELEGRAM_API_HASH=
TELEGRAM_ALLOWED_USER_IDS=
```

完整变量及默认值以仓库的 [`.env.example`](https://github.com/hicocos/tg-vault/blob/main/.env.example) 为准。

## 4. 构建并启动

```bash
docker compose config --quiet
docker compose up -d --build
docker compose ps
```

Compose 会把 `VITE_API_URL` 作为构建参数写入前端。以后修改这个地址时，必须再次执行 `docker compose up -d --build`；只重启前端容器不会改变已经打包的 API 地址。

如果需要账号级 Telegram 下载器，在服务启动后运行：

```bash
docker compose run --rm --no-deps backend npm run login:telegram-user
```

登录流程会在持久卷中生成账号 session。只使用 Bot 基础能力时可跳过。

## 5. 配置反向代理

推荐使用两个 HTTPS 域名：

- `https://cloud.example.com` → `http://127.0.0.1:47832`
- `https://api.example.com` → `http://127.0.0.1:51947`

仓库提供可修改的 [Nginx 示例](https://github.com/hicocos/tg-vault/blob/main/deploy/nginx-site.conf)。上传链路应关闭请求缓冲、放宽请求体限制，并为大文件设置足够长的读写超时。

OAuth 平台需要登记精确回调地址：

```text
https://api.example.com/api/storage/onedrive/callback
https://api.example.com/api/storage/google-drive/callback
```

## 6. 首次打开

访问 Web 域名后，系统会引导创建：

1. 至少 8 位的网页管理员密码
2. Telegram Bot 使用的 4 位数字 PIN

管理员密码和 Bot PIN 都不会以明文保存。登录后会使用 HttpOnly Cookie 会话。

## 7. 验证部署

```bash
docker compose ps
curl -fsS http://127.0.0.1:51947/livez
curl -fsS http://127.0.0.1:51947/readyz
curl -I http://127.0.0.1:47832/
```

- `/livez` 检查后端进程是否存活。
- `/readyz` 检查数据库、存储、安全密钥以及按配置要求启用的 Telegram 组件是否可用。
- `/livez=200` 但 `/readyz=503` 表示进程还在，但某个必需组件没有就绪；查看后端日志定位具体组件。

```bash
docker compose logs --tail=150 backend frontend postgres
```

## 下一步

- [配置存储源](./storage.html)
- [配置 Telegram](./telegram.html)
- [生产运维、备份与恢复](./operations.html)
- [安全说明](./security.html)
