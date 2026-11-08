<p align="center">
  <a href="README.md">简体中文</a> | <strong>English</strong>
</p>

<p align="center"><img src="https://raw.githubusercontent.com/hicocos/tg-vault/main/backend/logo.png" alt="TG Vault Logo" width="150" /></p>

# TG Vault

Telegram file transfer and archiving with multi-account scheduling, web file management and multiple storage providers.

[Documentation](https://tgvault.pages.dev/) · [Quick start](#quick-start) · [Changelog](CHANGELOG.md) · [Releases](https://github.com/hicocos/tg-vault/releases)

## Features

- Telegram file transfers, channel/group batch downloads by date or tag, and subscription sync.
- Multi-account Telegram scheduling based on source access and account availability.
- Web uploads, search, folder organization and media previews.
- Web and Bot task management: progress, failure details, pause, resume and retry.
- Local disk, OneDrive, Google Drive, Aliyun OSS, S3, WebDAV and OpenList storage.
- Administrator password, Bot user allowlist and TOTP two-factor authentication.

Channel downloads and subscriptions require a Telegram user account with source access. TG Vault does not bypass Telegram permissions or server limits.

See [multi-account scheduling](https://tgvault.pages.dev/usage/multi-account) (Chinese) for account setup and concurrency limits.

## Quick start

Prepare a Linux server with Bash 4+, curl and Git, Docker Compose, and Web/API HTTPS domains under the same parent domain.

```bash
curl -fsSL https://raw.githubusercontent.com/hicocos/tg-vault/main/install.sh | bash
```

By default, this downloads into `tg-vault` under the current directory and starts the installer. Running it from the project root reuses that project. To choose a directory, set `TG_VAULT_INSTALL_DIR=/opt/tg-vault` before `bash` on the right side of the pipe. See the [deployment guide](deploy/DEPLOY.md#2-首次安装) (Chinese) for all options.

The installer generates deployment configuration automatically. Restrict both Web/API endpoints to your own access until HTTPS is active and you have created the administrator password.

## Backup and updates

Back up `.env`, the database and complete file data before upgrading, then run from the project directory:

```bash
curl -fsSL https://raw.githubusercontent.com/hicocos/tg-vault/main/install.sh | bash
```

The script updates source and pulls `latest`, retaining existing configuration and data mounts. See [backup and recovery](deploy/DEPLOY.md#7-备份与恢复). Do not troubleshoot with `docker compose down -v`.

## Documentation

- [Online documentation](https://tgvault.pages.dev/) (Chinese): deployment, Telegram, storage and daily usage.
- [Documentation website](website/README.md) (Chinese): guides, local search and Cloudflare Pages publishing.
- [Deployment guide](deploy/DEPLOY.md) (Chinese): installation, HTTPS, backups, recovery and updates.
- [Configuration and usage](docs/configuration.md) (Chinese): environment variables, Telegram, storage and permissions.
- [MCP and AI agents](docs/mcp.md) (Chinese, with Codex configuration examples): client authorization, connection and usage.
- [Local storage locations](docs/local-storage.md) (Chinese, with an English summary): mounts, path verification and data protection.
- [Development and publishing](docs/development.md) (Chinese): isolated development, database CLI, checks and publication boundaries.

## Optional extension

With a separately deployed, same-host qBittorrent instance, TG Vault can transfer completed downloads to configured storage, then clean up source files or retain them for seeding. Telegram transfers do not require this extension. See [configuration](docs/configuration.md#qbittorrent-扩展) and the [usage guide](https://tgvault.pages.dev/usage/qbittorrent) (Chinese).

## License

[MIT License](LICENSE) · [hicocos/tg-vault](https://github.com/hicocos/tg-vault)
