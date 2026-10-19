<p align="center">
  <a href="README.md">简体中文</a> | <strong>English</strong>
</p>

<p align="center"><img src="backend/logo.png" alt="TG Vault Logo" width="150" /></p>

# TG Vault

Telegram file transfer and archiving with web file management and multiple storage providers.

[Quick start](#quick-start) · [Deployment guide](deploy/DEPLOY.md) · [Changelog](CHANGELOG.md) · [Releases](https://github.com/hicocos/tg-vault/releases)

## Features

- Telegram file transfers, channel/group batch downloads by date or tag, and subscription sync.
- Web uploads, search, folder organization and media previews.
- Web and Bot task management: progress, failure details, pause, resume and retry.
- Local disk, OneDrive, Google Drive, Aliyun OSS, S3, WebDAV and OpenList storage.
- Administrator password, Bot user allowlist and TOTP two-factor authentication.

Channel downloads and subscriptions require a Telegram user account with source access. TG Vault does not bypass Telegram permissions or server limits.

## Quick start

Prepare a Linux server, Docker Compose, and Web/API HTTPS domains under the same parent domain.

```bash
git clone https://github.com/hicocos/tg-vault.git
cd tg-vault
./deploy/install.sh
```

For a fresh installer run, do not copy `.env.example` first; the installer generates deployment configuration. Restrict both Web/API endpoints to your own access until HTTPS is active and you have created the administrator password.

## Backup and updates

Back up `.env`, the database and complete file data before upgrading, then run from the project directory:

```bash
./deploy/install.sh
```

The script updates source and pulls `latest`, retaining existing configuration and data mounts. See [backup and recovery](deploy/DEPLOY.md#7-备份与恢复). Do not troubleshoot with `docker compose down -v`.

## Documentation

- [Deployment guide](deploy/DEPLOY.md) (Chinese): installation, HTTPS, backups, recovery and updates.
- [Configuration and usage](docs/configuration.md) (Chinese): environment variables, Telegram, storage and permissions.
- [Local storage locations](docs/local-storage.md) (Chinese, with an English summary): mounts, path verification and data protection.
- [Development and publishing](docs/development.md) (Chinese): isolated development, database CLI, checks and publication boundaries.

## Repository and runtime data

Keep source, lockfiles, deployment scripts and behavioral regression tests in Git. Actual `.env` files, file data, Telegram sessions, keys, backups and build output stay private. Ignored files are not disposable. Review both pending files and Git history before publishing; never clean a deployment directory with `git clean -fdx`.

## License

[MIT License](LICENSE) · [hicocos/tg-vault](https://github.com/hicocos/tg-vault)
