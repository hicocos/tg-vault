<p align="center">
  <a href="README.md">简体中文</a> | <strong>English</strong>
</p>

<p align="center"><img src="backend/logo.png" alt="TG Vault Logo" width="150" /></p>

# TG Vault

Telegram file transfer, media archiving and multi-storage file management for individuals and small teams. Manage files in the web UI and archive content you are entitled to save from Telegram private chats, channels and groups to your own storage.

[Quick start](#quick-start) · [Bot commands](#telegram-bot-commands) · [Deployment guide](deploy/DEPLOY.md) · [简体中文](README.md)

## Features

- File uploads, folder organization, search and media previews.
- Telegram Bot transfers, channel/group batch downloads by date or tag, and channel subscription sync.
- Web and Bot task management: progress, destinations, failure details, pause, resume, cancel and retry.
- Local disk, OneDrive, Google Drive, Aliyun OSS, S3 and WebDAV storage, with source and directory rules for archiving.
- Administrator password, Bot user allowlist and PIN, and TOTP two-factor authentication.

TG Vault does not bypass Telegram permissions or download restrictions. Channel downloads and subscriptions require a Telegram user account with access to the source; sending files directly to the Bot does not require a personal account. Bot downloads in this project use MTProto, not the HTTP Bot API's `getFile`: its size limit cannot simply be applied here, and arbitrary files are not guaranteed to download. Direct Bot messages without a readable original source still use Bot downloads; adding a personal account does not automatically remove that path's restrictions. See [configuration](docs/configuration.md#telegram-配置与能力).

## Quick start

Prepare a Linux server, Docker Compose, and two HTTPS addresses under the same parent domain, such as `cloud.example.com` and `api.example.com`. The host or your management panel provides certificates and the reverse proxy.

```bash
git clone https://github.com/hicocos/tg-vault.git
cd tg-vault
./deploy/install.sh
```

Do not copy `.env.example` before a fresh installer run. Enter your Web/API addresses and a new dedicated storage directory. The installer generates the database password and application keys, then pulls `ghcr.io/hicocos/tg-vault-backend:latest` and `ghcr.io/hicocos/tg-vault-frontend:latest` from GHCR without compiling locally. The default file directory is `<installation>/data`; existing deployments retain their original mount, with no automatic file migration.

1. Configure HTTPS reverse proxies for Web → `127.0.0.1:47832` and API → `127.0.0.1:51947` as described in the [deployment guide](deploy/DEPLOY.md#4-配置宿主机反向代理).
2. **Restrict both endpoints to your own access until initialization is complete.** The first person to finish setup chooses the administrator password; there is no default password. Set a strong password of at least eight characters over HTTPS before opening access.
3. Under **Settings → Telegram**, enter the Bot Token, API ID and API Hash, set a Bot PIN, and configure an allowlist of numeric user IDs. For channel downloads or subscriptions, also log in with a personal Telegram account on that page.
4. Add other storage accounts under **Settings → Storage** and back up the configuration, database and complete `/data` directory.

If pulling fails, the platform is unsupported, or the two images belong to different revisions, the installer falls back to a local source build. Use `./deploy/install.sh --build` to force source builds, adding `--compat` for older build environments. Updates always pull `latest` rather than pinning a version; back up before upgrading. See the [deployment guide](deploy/DEPLOY.md), currently in Chinese.

## Telegram Bot commands

After connecting, send `/start` to authenticate and `/help` for the full command list and arguments. Browse and search files in the web UI.

| Command | Purpose |
| --- | --- |
| `/tasks` | View tasks, progress and controls |
| `/storage` | View storage status |
| `/path_rules` | Configure save locations and directory rules |
| `/target` | Set the storage target for the current chat |
| `/tg_download` | Open the channel/group date or tag download wizard |
| `/tg_sub`, `/tg_subs` | Manage and list subscriptions |
| `/tg_retry` | Retry failed tasks |
| `/setup_2fa` | Configure TOTP two-factor authentication |

Channel processing progress includes successful, failed and skipped items; 100% does not mean all files succeeded. Scan totals may be unknown. Queued tasks and Telegram cooldowns do not indicate active transfer. Pausing stops subsequent reads, but in-flight requests or storage writes may still finish.

## Backup and updates

Create a coordinated backup from the project root before updating with the installer:

```bash
BACKUP_DIR=/path/to/secure-backups ./deploy/backup.sh
./deploy/restore-verify.sh /path/to/secure-backups/<timestamp>
./deploy/install.sh
```

The backup script stops the backend while archiving, then restores its previous running state. **Back up `.env` and reverse-proxy configuration separately.** The script includes the database, complete `/data` and a checksum manifest, not files held by remote storage providers. Archive verification is not a restore drill. Upgrades automatically apply database migrations; rollback must preserve database/file consistency rather than simply running an older image. Do not troubleshoot with `docker compose down -v`. See [backup and recovery](deploy/DEPLOY.md#7-备份与恢复).

## Local builds and contributions

Container builds use Node.js 24; Node.js 24 and npm are also recommended for local builds. Install and build each subproject independently:

```bash
npm --prefix backend ci
npm --prefix frontend ci
npm --prefix backend run build
npm --prefix frontend run build
```

Running the backend locally also requires PostgreSQL and `DATABASE_URL`; thumbnails/transcoding require ffmpeg. See [local development](docs/configuration.md#本地开发) for startup and environment details. Describe the purpose, reproduction steps and checks actually performed in contributions. Keep lockfiles and Chinese/English documentation in sync. Database changes should update the schema, migrations and `init.sql`; do not rewrite released migrations.

GitHub Actions publishes universal amd64/arm64 images using the repository's built-in `GITHUB_TOKEN`, with `packages: write` granted only to publishing jobs. No additional registry credentials are required. After the first publication, maintainers must set both container packages to Public in GitHub Packages to allow anonymous pulls. The container receives `VITE_API_URL` at startup, so different domains do not require recompilation. This address is public: never include secrets in it.

Before publishing commits or sharing issue logs, exclude `.env`, tokens, API hashes, passwords, cookies, Telegram sessions, databases/backups, user files and private server details. Do not commit `node_modules`, `dist`, coverage, temporary debug/smoke scripts or local execution reports. Ignore rules do not remove secrets already committed to Git history; revoke/rotate leaked credentials and clean the history.

## Documentation

- [Deployment guide](deploy/DEPLOY.md): installation, HTTPS, backups, recovery and updates.
- [Configuration and usage](docs/configuration.md): environment variables, Telegram, storage and permissions.
- [Local storage locations](docs/local-storage.md): mounts, path verification and data protection.
- [Releases](https://github.com/hicocos/tg-vault/releases).

## License

[MIT License](LICENSE) · [hicocos/tg-vault](https://github.com/hicocos/tg-vault)
