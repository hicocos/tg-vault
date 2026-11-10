<div align="center">

<img src="https://raw.githubusercontent.com/hicocos/tg-vault/main/backend/logo.png" alt="TG Vault Logo" width="132" />

# TG Vault

**Self-Hosted Telegram Multi-Account File Transfer, Channel Subscription & Multi-Cloud Archiving Platform**

<p>
  <a href="https://github.com/hicocos/tg-vault/releases"><img src="https://img.shields.io/badge/release-v3.0.0-326fe8?style=flat-square" alt="Release" /></a>
  <a href="https://tgvault.pages.dev/"><img src="https://img.shields.io/badge/docs-tgvault.pages.dev-27a979?style=flat-square" alt="Documentation" /></a>
  <img src="https://img.shields.io/badge/docker-ready-2496ed?style=flat-square&logo=docker&logoColor=white" alt="Docker" />
  <img src="https://img.shields.io/badge/MCP-AI_Agent-6e56cf?style=flat-square" alt="MCP Ready" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-475569?style=flat-square" alt="License" /></a>
</p>

<p>
  <a href="README.md">简体中文</a> · <strong>English</strong>
</p>

<p>
  <a href="https://tgvault.pages.dev/">Documentation</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#storage-backends">Storage Backends</a> ·
  <a href="#bot-commands">Bot Commands</a> ·
  <a href="CHANGELOG.md">Changelog</a> ·
  <a href="https://github.com/hicocos/tg-vault/releases">Releases</a>
</p>

</div>

## ✨ Key Features

| Module | Capabilities |
| :--- | :--- |
| **👥&nbsp;Multi&#8209;Account** | Connect multiple Telegram user accounts via QR code or phone login; automatically routes downloads based on source access, cooldown status, and **weighted least-connections** scheduling. |
| **📡&nbsp;Channel&nbsp;Sync** | Batch download channel/group history by **date range** or **hashtag**, or set up recurring subscriptions for new media with built-in file type and ad filtering. |
| **🤖&nbsp;Bot&nbsp;&amp;&nbsp;Tasks** | Forward files or media groups directly to your Bot; monitor live progress, speed, and failure details across Web and Bot with pause, resume, and retry controls. |
| **🗂️&nbsp;Web&nbsp;Manager** | Resumable chunked uploads, full-text search, favorites, folder organization, streaming audio/video playback, and inline image previews. |
| **☁️&nbsp;7&nbsp;Storages** | Native support for **Local Disk, OneDrive, Google Drive, S3 / Cloudflare R2, Aliyun OSS, WebDAV, and OpenList**, with multi-account management and per-task target routing. |
| **🔌&nbsp;MCP&nbsp;&amp;&nbsp;BT** | Built-in **MCP Server** (Streamable HTTP & stdio) for AI agents (Claude, Codex, Rikka) to search, read, and archive files; optional **qBittorrent** integration for post-download cloud transfers. |
| **🔐&nbsp;Security&nbsp;&amp;&nbsp;i18n** | Admin password, TOTP 2FA, Bot user allowlist, encrypted credential storage, and full UI/Bot localization in **Simplified Chinese, English, and Russian**. |

## 🧩 Workflow Architecture

| Stage | Pipeline |
| :--- | :--- |
| **1.&nbsp;Ingress** | **Telegram**: Bot private forwards · Channel batch download by date/tag · Recurring subscriptions<br>**Web & Extensions**: Chunked web uploads · MCP AI Agent tool calls · qBittorrent magnet/torrent sync |
| **2.&nbsp;Core&nbsp;Engine** | **Multi-Account Scheduler**: Source access check → Cooldown avoidance → Idle priority → Weighted least-connections<br>**Persistent Task Queue**: PostgreSQL state tracking · Media group aggregation · File/ad filtering · Resumable transfers |
| **3.&nbsp;Storage** | **7 Storage Targets**: Local Disk · OneDrive · Google Drive · S3 / R2 · Aliyun OSS · WebDAV · OpenList<br>**Unified File Index**: Cross-storage search · Streaming media preview · Folder organization · MCP text reading |

## 🚀 Quick Start

Run the one-line command to install or update interactively:

```bash
curl -fsSL https://raw.githubusercontent.com/hicocos/tg-vault/main/install.sh | bash
```

The wizard automatically generates configuration, runs database migrations, and starts the services. See the [deployment guide](https://tgvault.pages.dev/guide/quick-start) for details.

## 📦 Storage Backends

Add multiple storage accounts under **Settings → Storage** and assign targets globally, per Bot session, or per channel subscription:

| Provider | Protocol / Auth | Highlights | Guide |
| :--- | :--- | :--- | :--- |
| **Local Disk** | Host Volume Mount | Zero external dependencies, fast local I/O and direct media streaming | [Local Storage](https://tgvault.pages.dev/storage/local) |
| **OneDrive** | Microsoft OAuth 2.0 | Personal & business accounts, resumable chunked uploads, multi-account | [OneDrive Guide](https://tgvault.pages.dev/storage/onedrive) |
| **Google Drive** | Google OAuth 2.0 | My Drive & Shared Drives, resumable upload sessions, trash management | [Google Drive Guide](https://tgvault.pages.dev/storage/google-drive) |
| **S3 / Cloudflare R2** | S3-Compatible API | Multipart uploads for AWS S3, Cloudflare R2, MinIO, and compatible object stores | [S3 / R2 Guide](https://tgvault.pages.dev/storage/s3) |
| **Aliyun OSS** | Aliyun OSS API | Scoped RAM credentials and high-speed multipart transfers | [Aliyun OSS Guide](https://tgvault.pages.dev/storage/oss) |
| **WebDAV / NAS** | Basic / Digest Auth | Connects to Synology, QNAP, Nextcloud, and standard DAV servers | [WebDAV Guide](https://tgvault.pages.dev/storage/webdav) |
| **OpenList** | Native OpenList API | Direct integration with mounted OpenList storage paths | [OpenList Guide](https://tgvault.pages.dev/storage/openlist) |

## 🤖 Bot Commands

| Command | Description |
| :--- | :--- |
| `/start` | Authenticate and link your Telegram account |
| `/tg_download` | Launch interactive channel/group history download wizard (by date or tag) |
| `/tg_sub` / `/tg_subs` | Create a channel subscription, or inspect, pause, and resume subscriptions |
| `/tasks` | View active transfers and pause, resume, cancel, or retry tasks |
| `/target` | Switch the default target storage account and directory for Bot transfers |
| `/status` | Check instance health, queue summary, and storage connectivity |

## 🔌 Extensions

- **MCP for AI Agents**: Exposes file search, UTF-8 text reading, chunked uploads, subscription management, and channel archiving over Streamable HTTP or local stdio with scoped Bearer tokens. See [MCP Guide](docs/mcp.md).
- **qBittorrent Integration**: Connects to a local qBittorrent WebUI to add magnet links or `.torrent` files, select files, and automatically transfer completed downloads to cloud storage while optionally keeping torrents seeding. See [qBittorrent Guide](https://tgvault.pages.dev/usage/qbittorrent).

## 📚 Documentation

| Resource | Description |
| :--- | :--- |
| **[Online Documentation](https://tgvault.pages.dev/)** | Full user guides, multi-account scheduling, storage setup, and troubleshooting |
| **[Deployment Guide](deploy/DEPLOY.md)** | Installer options, Nginx HTTPS reverse proxy, database migrations, and maintenance |
| **[Configuration Reference](docs/configuration.md)** | Environment variables, Telegram credentials, storage setup, and security settings |
| **[MCP & AI Agents](docs/mcp.md)** | Permission scopes, client setup (Codex / Rikka), and tool call examples |
| **[Local Storage](docs/local-storage.md)** | Volume mounts, path verification, and data persistence |
| **[Development Guide](docs/development.md)** | Local development setup, database CLI, and build verification |

## 📄 License

Released under the [MIT License](LICENSE) · [hicocos/tg-vault](https://github.com/hicocos/tg-vault)
