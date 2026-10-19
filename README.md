<p align="center">
  <strong>简体中文</strong> | <a href="README_EN.md">English</a>
</p>

<p align="center"><img src="backend/logo.png" alt="TG Vault Logo" width="150" /></p>

# TG Vault

Telegram 文件转存与归档工具，支持 Web 文件管理和多种存储服务。

[快速部署](#快速部署) · [部署指南](deploy/DEPLOY.md) · [更新日志](CHANGELOG.md) · [版本发布](https://github.com/hicocos/tg-vault/releases)

## 功能概览

- Telegram 文件转存、频道/群组按日期或标签批量下载、订阅同步。
- Web 文件上传、搜索、文件夹整理与媒体预览。
- Web 与 Bot 任务管理：进度、失败明细、暂停、继续及重试。
- 本地磁盘、OneDrive、Google Drive、阿里云 OSS、S3、WebDAV 和 OpenList 存储。
- 管理员密码、Bot 用户允许列表与 TOTP 双重验证。

频道下载与订阅需要有来源访问权限的 Telegram 用户账号，不绕过 Telegram 权限或服务端限制。

## 快速部署

准备 Linux 服务器、Docker Compose，以及同一主域名下的 Web/API 两个 HTTPS 域名。

```bash
git clone https://github.com/hicocos/tg-vault.git
cd tg-vault
./deploy/install.sh
```

全新安装不要先复制 `.env.example`，安装器会生成部署配置。首次管理员初始化前，限制 Web/API 两个入口仅自己可访问；HTTPS 生效后创建管理员密码，再开放服务。

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
- [开发与发布](docs/development.md)：独立开发环境、数据库 CLI、检查命令及公开发布边界。

## 仓库与数据

仓库保留源码、锁文件、部署脚本和行为回归测试。实际 `.env`、文件数据、Telegram session、密钥、备份及构建产物不提交；被忽略不等于可删除。发布前检查历史提交与待提交文件，不要用 `git clean -fdx` 清理部署目录。

## 开源协议

[MIT License](LICENSE) · [hicocos/tg-vault](https://github.com/hicocos/tg-vault)
