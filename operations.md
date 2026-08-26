---
title: 运维、备份与恢复
description: 更新 TG Vault，检查健康状态，备份数据并安全清理 Docker
---

{% include nav.html %}

# 运维、备份与恢复

所有命令都应在包含 `docker-compose.yml` 的 TG Vault 项目目录执行。

## 更新

<div class="callout warning">
从 v2.0.5 或更早版本升级前，如果旧数据库仍包含废弃 AI 功能留下的 <code>vector</code> 扩展或 <code>public.ai_*</code> 表，不能直接重建 PostgreSQL 容器。请先按<a href="https://github.com/hicocos/tg-vault/blob/main/deploy/DEPLOY.md">部署指南</a>运行安全迁移脚本；安装向导检测到旧对象时会停止。
</div>

推荐让安装脚本同步刷新源码版本信息并重建服务：

```bash
git fetch origin
git status --short
git pull --ff-only origin main
./deploy/install.sh
docker compose ps
```

也可手动执行 `docker compose up -d --build`，但应同时维护 `.env` 中的构建版本元数据。

如果 `git status --short` 显示本地改动，先人工确认，不要强制覆盖。`docker compose up -d --build` 会重新构建前后端，同时保留 named volumes 中的数据库与文件。

修改 `VITE_API_URL` 后必须重新构建前端。

## 健康检查

```bash
docker compose ps
curl -fsS http://127.0.0.1:51947/livez
curl -fsS http://127.0.0.1:51947/readyz
curl -I http://127.0.0.1:47832/
```

- `/livez`：后端进程存活。
- `/readyz`：数据库、存储、安全密钥和配置为必需的 Telegram 组件已就绪。
- Web 入口：前端容器能够提供静态资源。

查看日志：

```bash
docker compose logs --tail=200 backend
docker compose logs --tail=100 frontend postgres
docker compose logs -f backend
```

## 常用操作

```bash
docker compose restart
docker compose stop
docker compose start
docker compose down
```

`docker compose down` 默认不会删除 named volumes。不要添加 `-v`，除非明确要永久删除 PostgreSQL、文件、密钥和 Telegram session。

## 备份

一次可恢复的备份必须来自同一维护窗口，并包含：

1. PostgreSQL custom-format dump
2. `file-storage` 卷中的完整 `/data`
3. 版本、时间和 SHA-256 manifest

使用仓库脚本：

```bash
chmod +x deploy/backup.sh deploy/restore-verify.sh
BACKUP_DIR=./backups ./deploy/backup.sh
```

脚本会先检查目标空间，然后在数据库 dump 与文件卷归档期间停止 backend，避免上传、删除或 Telegram 后台写入跨越两个快照；结束或失败退出时会恢复 backend。

<div class="callout warning">
备份包含内部密钥、第三方存储凭据和 Telegram session。生成后应立即加密、限制权限并复制到异地；不要把 <code>backups/</code> 提交到 Git。
</div>

## 恢复前验证

在隔离环境运行只读验证：

```bash
./deploy/restore-verify.sh ./backups/<backup-directory>
```

验证脚本会检查 manifest 与归档结构，但不能代替完整恢复演练。定期在隔离 Compose 项目中验证：

- 数据库 schema 和关键行数
- `/data/secrets` 可读
- 已保存存储账户可以解密
- Web 管理的 Telegram Bot 凭据和用户 session 可解密；旧部署仍应核对遗留 session 文件
- `/readyz` 可以通过
- 文件预览和下载链路可用

## Docker 空间清理

先查看：

```bash
docker system df
docker system df -v
```

优先清理不会删除 named volumes 的资源：

```bash
docker builder prune -f
docker image prune -f
docker container prune -f
docker network prune -f
```

需要更大范围时，先确认镜像可重新构建并已有有效备份，再考虑：

```bash
docker image prune -a -f
```

<div class="callout warning">
不要对 TG Vault 服务器随意运行 <code>docker system prune --volumes</code>、<code>docker volume prune</code> 或 <code>docker compose down -v</code>。卷中包含数据库、文件、密钥和 session；误删后只能从备份恢复。
</div>

## 故障排查

### backend 不健康

```bash
docker compose ps
docker compose logs --tail=250 backend
curl -i http://127.0.0.1:51947/livez
curl -i http://127.0.0.1:51947/readyz
```

`livez=200`、`readyz=503` 通常表示数据库、默认存储、安全密钥或必需的 Telegram 组件没有就绪。

### PostgreSQL 连接失败

```bash
docker compose exec postgres pg_isready -U tgvault -d tgvault
docker compose logs --tail=200 postgres
```

### HTTPS、CORS 或 OAuth 失败

核对：

- Web/API DNS 与证书
- Nginx upstream 是否是 `127.0.0.1:47832` 和 `127.0.0.1:51947`
- `VITE_API_URL`、`CORS_ORIGIN`、`OAUTH_CALLBACK_BASE_URL`、`OAUTH_FRONTEND_ORIGIN`
- 前端是否在修改 API 地址后重新构建
- OAuth 平台登记的回调地址是否精确一致

### 上传大文件失败

检查反向代理请求体限制、`proxy_request_buffering`、读写超时、临时磁盘、分片限制和后端日志。WebDAV 目标还应检查无活动与总上传超时。

## 权威运维说明

生产发布的完整容器标签核对、Nginx、备份一致性和恢复验证细节，以仓库的 [`deploy/DEPLOY.md`](https://github.com/hicocos/tg-vault/blob/main/deploy/DEPLOY.md) 和脚本源码为准。

---

[返回文档中心](./) · [安全说明](./security.html)
