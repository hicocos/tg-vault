# 部署前准备

## 服务器

| 项目 | 要求 |
| --- | --- |
| 系统 | Linux，Bash 4+、Python 3.7+、Git；一键下载入口需要 curl |
| 容器 | Docker Engine、Compose 插件 2.18+；不支持 Python `docker-compose` v1 |
| 权限 | 当前用户能访问 Docker daemon |
| 网络 | 可访问 GitHub、GHCR，以及按需启用的 Telegram 和存储服务 |
| 域名 | 同一主域名下的 Web/API 两个 HTTPS 子域名 |
| 反代 | 宿主机 Nginx、管理面板或其他 HTTPS 代理 |
| 磁盘 | 专用持久目录，留足下载、分片、预览和备份空间 |

镜像安装无需宿主机 Node.js、npm 或 Buildx。源码构建需要 Buildx，默认构建证明要求 Compose 2.39+；旧环境见[完整部署](/deploy/installation)的 `--compat`。

```bash
docker version
docker compose version
python3 --version
git --version
df -h
df -i
```

## 域名与入口

- Web/API 例如 `cloud.example.com`、`api.example.com`，均解析到服务器并配置有效证书。
- 默认上游为 `127.0.0.1:47832` 和 `127.0.0.1:51947`，无需直接对公网开放。
- 管理员初始化前，两个入口都应仅允许自己访问。
- 文档站地址不用于 `CORS_ORIGIN`、API 或 OAuth 回调。

## 按需准备凭据

| 功能 | 材料 |
| --- | --- |
| Bot | [BotFather](https://t.me/BotFather) 的 Token；[my.telegram.org](https://my.telegram.org) 的 API ID/Hash；数字用户 ID |
| 频道下载/订阅 | 有来源权限的个人账号，登录时使用验证码及可选两步验证密码 |
| OneDrive/Google Drive | 自建 Web OAuth 应用、Client ID/Secret、实际回调地址 |
| OSS/S3 | 桶、Region、API 地址和专用访问密钥 |
| WebDAV/OpenList | 接口地址、可写目录和专用用户凭据 |

凭据填写在自己的 TG Vault HTTPS 管理页，不提交到文档站或公开 Issue。

## 数据目录

新安装默认 `<项目目录>/data`，也可用已挂载磁盘下的新目录，如 `/mnt/archive/tg-vault-data`。上级目录必须存在；安装器创建目录为 `0700`、UID/GID `1000:1000`，不接受符号链接或 `..`。

安装器会自动生成配置。已有部署保留原挂载，不自动迁移。详细路径规则见[本地存储](/storage/local)。
