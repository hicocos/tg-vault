<p align="center">
  <strong>简体中文</strong> | <a href="README_EN.md">English</a>
</p>

<p align="center"><img src="https://raw.githubusercontent.com/hicocos/tg-vault/main/backend/logo.png" alt="TG Vault Logo" width="150" /></p>

# TG Vault

Telegram 文件转存与归档工具，支持多个人账号调度、Web 文件管理和多种存储服务。

[使用文档](https://tgvault.pages.dev/) · [快速部署](#快速部署) · [更新日志](CHANGELOG.md) · [版本发布](https://github.com/hicocos/tg-vault/releases)

## 功能概览

- Telegram 文件转存、频道/群组按日期或标签批量下载、订阅同步。
- 多 Telegram 账号调度，按来源权限和账号状态分配任务。
- Web 文件上传、搜索、文件夹整理与媒体预览。
- Web 与 Bot 任务管理：进度、失败明细、暂停、继续及重试。
- 本地磁盘、OneDrive、Google Drive、阿里云 OSS、S3、WebDAV 和 OpenList 存储。
- 管理员密码、Bot 用户允许列表与 TOTP 双重验证。

频道下载与订阅需要有来源访问权限的 Telegram 用户账号，不绕过 Telegram 权限或服务端限制。

账号接入与并发说明见[多账号调度](https://tgvault.pages.dev/usage/multi-account)。

## 快速部署

准备 Linux 服务器（Bash 4+、curl、Git）、Docker Compose，以及同一主域名下的 Web/API 两个 HTTPS 域名。

```bash
curl -fsSL https://raw.githubusercontent.com/hicocos/tg-vault/main/install.sh | bash
```

默认下载到当前目录下的 `tg-vault` 并启动安装向导；在项目根目录运行时复用当前项目。可在管道右侧的 `bash` 前设置 `TG_VAULT_INSTALL_DIR=/opt/tg-vault` 指定目录。完整参数见[部署指南](deploy/DEPLOY.md#2-首次安装)。

安装器会自动生成部署配置。首次管理员初始化前，限制 Web/API 两个入口仅自己可访问；HTTPS 生效后创建管理员密码，再开放服务。

## 备份与更新

升级前备份 `.env`、数据库和完整文件数据，然后在项目目录运行：

```bash
curl -fsSL https://raw.githubusercontent.com/hicocos/tg-vault/main/install.sh | bash
```

脚本更新源码并拉取 `latest`，保留原配置和数据挂载。详见[备份与恢复](deploy/DEPLOY.md#7-备份与恢复)；不要用 `docker compose down -v` 排障。

## 文档

- [在线使用文档](https://tgvault.pages.dev/)：部署、Telegram、存储接入与日常使用。
- [文档站源码与发布](website/README.md)：专题教程、全文搜索与 Cloudflare Pages 部署。
- [部署指南](deploy/DEPLOY.md)：安装、HTTPS、备份、恢复与更新。
- [配置与使用](docs/configuration.md)：环境变量、Telegram、存储与权限。
- [MCP 与 AI Agent](docs/mcp.md)：客户端授权、接入和使用。
- [本地存储位置](docs/local-storage.md)：挂载、路径确认与数据保护。
- [开发与发布](docs/development.md)：独立开发环境、数据库 CLI、检查命令及公开发布边界。

## 可选扩展

自行部署同机 qBittorrent 后，可将完成的下载转存到已配置存储，默认清理源文件，也可保留做种。不使用该扩展不影响 Telegram 转存；见[配置](docs/configuration.md#qbittorrent-扩展)与[使用教程](https://tgvault.pages.dev/usage/qbittorrent)。

## 开源协议

[MIT License](LICENSE) · [hicocos/tg-vault](https://github.com/hicocos/tg-vault)
