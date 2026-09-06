---
title: 快速部署
description: 用安装脚本和 Docker Compose 快速部署 TG Vault
---

{% include nav.html %}

# 快速部署

TG Vault 的正式部署包含三个容器：`frontend`、`backend` 和 `postgres`（PostgreSQL 16）。宿主机上的 Nginx、Caddy、宝塔面板或其他反向代理负责域名与 HTTPS；Compose 不包含 Nginx 或 Certbot。

## 最短部署流程

```bash
git clone https://github.com/hicocos/tg-vault.git
cd tg-vault
./deploy/install.sh
```

首次部署按提示填写 Web 地址和 API 地址即可。

```text
TG Vault 安装向导

请输入 Web 前端 URL
示例：https://cloud.example.com
> https://cloud.example.com

请输入后端 API URL
示例：https://api.example.com
> https://api.example.com

配置确认
Web 前端 URL：https://cloud.example.com
后端 API URL：https://api.example.com

按 Enter 保存配置并开始安装，输入 e 重新编辑，输入 q 退出：
```

输入两个地址并按 Enter 确认后，脚本会一次性创建 `.env`、生成密钥、构建并启动服务，不需要手动编辑 `.env`。

## 1. 准备条件

- 一台 Debian、Ubuntu、Fedora、RHEL 或兼容发行版的 Linux 服务器
- 能使用 `root`，或普通用户拥有 `sudo` 权限
- 服务器可以访问系统软件源和 Docker 镜像仓库
- Web 域名，例如 `cloud.example.com`
- API 域名，例如 `api.example.com`
- 两个域名都已解析到服务器，并可配置 HTTPS

不要求预先安装 OpenSSL。安装脚本使用 Python 标准库的安全随机数生成数据库密码和应用密钥；它**不负责 SSL/TLS 证书**，证书仍由宿主机 Nginx、Caddy、宝塔面板或其他反向代理处理。

脚本启动时会检查 Docker、Docker Compose、Python 3 和 Git。如果有缺失，会显示提示。

按提示安装缺少的软件后，再重新执行上面的命令。

默认端口仅绑定宿主机回环地址：

| 服务 | 宿主机地址 |
| --- | --- |
| Web 前端 | `127.0.0.1:47832` |
| 后端 API | `127.0.0.1:51947` |

## 2. 安装向导

运行安装脚本后，按提示填写 Web 地址和 API 地址。脚本会自动生成密码和密钥，构建并启动服务。

以后升级时，进入项目目录再次运行同一条命令，已有地址直接按 Enter 保留。数据库、文件和密钥不会被删除。

## 3. 配置反向代理

推荐使用两个 HTTPS 域名：

- `https://cloud.example.com` → `http://127.0.0.1:47832`
- `https://api.example.com` → `http://127.0.0.1:51947`

仓库提供可修改的 [Nginx 示例](https://github.com/hicocos/tg-vault/blob/main/deploy/nginx-site.conf)。上传链路应关闭请求缓冲、放宽请求体限制，并为大文件设置足够长的读写超时。TLS 证书由宿主机反向代理或面板管理，不要运行 `docker compose run certbot`。

OAuth 平台登记的回调地址必须精确匹配：

```text
https://api.example.com/api/storage/onedrive/callback
https://api.example.com/api/storage/google-drive/callback
```

## 4. 首次打开 Web

访问 Web 域名，首次初始化只要求创建至少 8 位的网页管理员密码。登录使用 HttpOnly Cookie。

推荐随后进入 **设置 → Telegram** 配置 Bot：

1. 填写 Bot Token、API ID、API Hash 和 4 位 Bot PIN。
2. 点击 **测试连接**。
3. 点击 **保存并启用**。
4. 在 **Telegram Bot 用户权限** 中维护允许用户 ID。
5. 如需频道/群组抓取，再在同页使用手机号、验证码和可选两步验证密码登录账号级下载器。

## 5. 验证部署

```bash
docker compose ps
curl -fsS http://127.0.0.1:51947/livez
curl -fsS http://127.0.0.1:51947/readyz
curl -I http://127.0.0.1:47832/
```

- `/livez`：后端进程存活。
- `/readyz`：数据库、存储和安全密钥已就绪。
- Telegram 未配置或故障不会阻断 Web/API。

出现异常时查看：

```bash
docker compose logs --tail=150 backend frontend postgres
```

## 6. 升级

```bash
cd /www/wwwroot/tg-vault
./deploy/install.sh
```

按提示操作即可。

## 下一步

- [配置 Telegram Bot 与账号级下载器](./telegram.html)
- [配置存储源](./storage.html)

- [生产运维、备份与恢复](./operations.html)
- [安全说明](./security.html)
