<p align="center">
  <strong>简体中文</strong> | <a href="README_EN.md">English</a>
</p>

<p align="center"><img src="backend/logo.png" alt="TG Vault Logo" width="150" /></p>

# TG Vault

Telegram 文件转存与归档工具，支持 Web 文件管理和多种存储服务。

[快速部署](#快速部署) · [部署指南](deploy/DEPLOY.md) · [版本发布](https://github.com/hicocos/tg-vault/releases)

## 功能概览

- Telegram 文件转存、频道/群组按日期或标签批量下载、订阅同步。
- Web 文件上传、搜索、文件夹整理与媒体预览。
- Web 与 Bot 任务管理：进度、失败明细、暂停、继续及重试。
- 本地磁盘、OneDrive、Google Drive、阿里云 OSS、S3 和 WebDAV 存储。
- 管理员密码、Bot 用户允许列表与 TOTP 双重验证。

频道下载与订阅需要有来源访问权限的 Telegram 用户账号，不绕过 Telegram 权限或服务端限制。

## 快速部署

准备 Linux 服务器、Docker Compose，以及同一主域名下的 Web/API 两个 HTTPS 域名。

```bash
git clone https://github.com/hicocos/tg-vault.git
cd tg-vault
./deploy/install.sh
```

默认从 GHCR 拉取最新镜像，支持 amd64/arm64，无需登录或本机编译；拉取失败时自动源码构建兜底。首次安装**不要预先复制 `.env.example`**，按提示填写地址和文件保存目录。

1. 按[部署指南](deploy/DEPLOY.md#4-配置宿主机反向代理)配置 HTTPS：Web → `127.0.0.1:47832`，API → `127.0.0.1:51947`。
2. **初始化前仅允许自己访问两个入口**，打开网页设置管理员密码，再开放服务。
3. 在 **设置 → Telegram** 连接 Bot、配置用户权限；需要频道下载或订阅时，再登录 Telegram 用户账号。

Bot 发送 `/start` 开始，`/help` 查看命令。强制源码构建使用 `./deploy/install.sh --build`；更多选项见[部署指南](deploy/DEPLOY.md)。

## 备份与更新

升级前备份 `.env`、数据库和完整文件数据，然后在项目目录运行：

```bash
./deploy/install.sh
```

脚本更新源码并拉取 `latest`，保留原配置和数据挂载。详见[备份与恢复](deploy/DEPLOY.md#7-备份与恢复)；不要用 `docker compose down -v` 排障。

## 文档

- [部署指南](deploy/DEPLOY.md)：安装、HTTPS、备份、恢复与更新。
- [配置与使用](docs/configuration.md)：环境变量、Telegram、存储与权限。
- [本地存储位置](docs/local-storage.md)：挂载、路径确认与数据保护。
- [本地开发](docs/configuration.md#本地开发)：开发环境与构建检查。

## 开源协议

[MIT License](LICENSE) · [hicocos/tg-vault](https://github.com/hicocos/tg-vault)
