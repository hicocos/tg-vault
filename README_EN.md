<p align="center">
  <a href="README.md">简体中文</a> | <strong>English</strong>
</p>

<p align="center"><img src="backend/logo.png" alt="TG Vault Logo" width="150" /></p>

# TG Vault

Telegram file transfer and archiving with web file management and multiple storage providers.

[Quick start](#quick-start) · [Deployment guide](deploy/DEPLOY.md) · [Releases](https://github.com/hicocos/tg-vault/releases)

## Features

- Telegram file transfers, channel/group batch downloads by date or tag, and subscription sync.
- Web uploads, search, folder organization and media previews.
- Web and Bot task management: progress, failure details, pause, resume and retry.
- Local disk, OneDrive, Google Drive, Aliyun OSS, S3 and WebDAV storage.
- Administrator password, Bot user allowlist and TOTP two-factor authentication.

Channel downloads and subscriptions require a Telegram user account with source access. TG Vault does not bypass Telegram permissions or server limits.

## Quick start

Prepare a Linux server, Docker Compose, and Web/API HTTPS domains under the same parent domain.

```bash
git clone https://github.com/hicocos/tg-vault.git
cd tg-vault
./deploy/install.sh
```

## Backup and updates

Back up `.env`, the database and complete file data before upgrading, then run from the project directory:

```bash
./deploy/install.sh
```

The script updates source and pulls `latest`, retaining existing configuration and data mounts. See [backup and recovery](deploy/DEPLOY.md#7-备份与恢复). Do not troubleshoot with `docker compose down -v`.

## Documentation

- [Deployment guide](deploy/DEPLOY.md): installation, HTTPS, backups, recovery and updates.
- [Configuration and usage](docs/configuration.md): environment variables, Telegram, storage and permissions.
- [Local storage locations](docs/local-storage.md): mounts, path verification and data protection.
- [Local development](docs/configuration.md#本地开发): development setup and build checks.

## License

[MIT License](LICENSE) · [hicocos/tg-vault](https://github.com/hicocos/tg-vault)
