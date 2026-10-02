<p align="center">
  <a href="README.md"><strong>简体中文</strong></a> | <strong>English</strong>
</p>

<div align="center">
  <img src="backend/logo.png" alt="TG Vault Logo" width="150" />

  <h1>TG Vault</h1>

  <p>
    <strong>Telegram File Transfer & Archive</strong>
  </p>
  <p>
    A Telegram-based file transfer, media archiving and multi-storage file management system for individuals and small teams.
  </p>

  <p>
    <a href="#-quick-start-docker-compose"><strong>Quick Start</strong></a>
    ·
    <a href="#-features"><strong>Features</strong></a>
    ·
    <a href="#-telegram-bot-commands"><strong>Bot Commands</strong></a>
    ·
    <a href="deploy/DEPLOY.md"><strong>Deployment Guide</strong></a>
  </p>

  <p>
    <a href="https://github.com/hicocos/tg-vault/releases"><img src="https://img.shields.io/github/v/release/hicocos/tg-vault?style=for-the-badge&logo=github&color=2f81f7" alt="Latest Release" /></a>
    <a href="https://github.com/hicocos/tg-vault/blob/main/LICENSE"><img src="https://img.shields.io/github/license/hicocos/tg-vault?style=for-the-badge&logo=github&color=00b894" alt="License" /></a>
    <a href="https://github.com/hicocos/tg-vault/stargazers"><img src="https://img.shields.io/github/stars/hicocos/tg-vault?style=for-the-badge&logo=github&color=f1c40f" alt="Stars" /></a>
    <a href="https://github.com/hicocos/tg-vault/network/members"><img src="https://img.shields.io/github/forks/hicocos/tg-vault?style=for-the-badge&logo=github&color=8e44ad" alt="Forks" /></a>
  </p>
  <p>
    <img src="https://img.shields.io/badge/Telegram-Bot-26A5E4?style=flat-square&logo=telegram&logoColor=white" alt="Telegram Bot" />
    <img src="https://img.shields.io/badge/Docker-Compose-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker Compose" />
    <img src="https://img.shields.io/badge/React-TypeScript-3178C6?style=flat-square&logo=react&logoColor=white" alt="React TypeScript" />
    <img src="https://img.shields.io/badge/PostgreSQL-16-4169E1?style=flat-square&logo=postgresql&logoColor=white" alt="PostgreSQL 16" />
  </p>
</div>

Save files from Telegram private chats, channels or groups, then browse and manage them in the web UI. Supports local disk, OneDrive, Google Drive, OSS, S3 and WebDAV.

---

## ✨ Features

- **File management**: Upload, preview and organize folders; manage archives right in the browser.
- **Telegram transfer**: Send files to the Bot, or batch-save media from channels and groups.
- **Subscription sync**: Subscribe to channels and automatically save future updates.
- **Multiple storage backends**: Local disk, OneDrive, Google Drive, OSS, S3 and WebDAV.
- **Automatic archiving**: Organize files by source, channel and file type.
- **Access protection**: Admin login, Bot user permissions and two-factor authentication.

---

## 🚀 Quick Start (Docker Compose)

You will need a Linux server and two domain names — one for the web UI and one for the API.

### 1. Clone the project

```bash
git clone https://github.com/hicocos/tg-vault.git
cd tg-vault
```

### 2. Run the one-click script

```bash
./deploy/install.sh
```

Follow the prompts to check the environment and fill in the web and API addresses, then confirm to start the installation.

### 3. Get started

Set up HTTPS for both domains as described in the [deployment guide](deploy/DEPLOY.md#4-配置宿主机反向代理), then open the web page and create your admin account.

Go to **Settings → Telegram** to connect a Bot. If you need channel transfers or subscription sync, also log in with your Telegram account. Other storage backends can be added under **Settings → Storage**.

[View the full deployment guide](deploy/DEPLOY.md) · [Telegram configuration guide](docs/configuration.md#-telegram-配置与能力)

> Note: The deployment and configuration docs are currently available in Chinese only.

---

## 🧭 Telegram Bot Commands

After connecting the Bot, send `/start` to begin and `/help` to view the help message.

| Command | Purpose |
| --- | --- |
| `/list` | View recent files |
| `/tasks` | View and manage tasks |
| `/storage` | View storage status |
| `/path_rules` | Set the save location |
| `/tg_download` | Open the channel/group download wizard |
| `/tg_sub` | Add a channel subscription |
| `/tg_subs` | View subscriptions |

Channel downloads and subscriptions require logging in with a Telegram account that has access to them.

<details>
<summary>More commands</summary>

- **File management**: `/delete <ID prefix of at least 8 characters>` deletes a file; `/setup_2fa` sets up two-factor authentication.
- **Task control**: `/task_pause [task ID]`, `/task_resume [task ID]`, `/task_cancel <task ID or all>`, `/stop_tasks`.
- **Save directory**: `/p <directory>` applies to the next download only; `/ps <directory>` applies to the current session; `/pc` clears the custom directory.
- **Batch downloads**: `/tg_download date <channel> <start date> <end date>`, `/tg_download tag <channel> <#tag>`.
- **Subscriptions & retries**: `/tg_unsub <channel or subscription ID prefix>` cancels a subscription; `/tg_retry [count] [task ID]` retries failed tasks.
- **Download settings**: `/download_workers`, `/file_concurrency`, `/duplicate_mode`, `/cleanup_settings`.

</details>

---

## 🔄 Maintenance & Updates

Go to your TG Vault project directory and run the one-click upgrade script:

```bash
./deploy/install.sh
```

---

## 📚 Documentation

- [Deployment guide](deploy/DEPLOY.md): installation, domain configuration, environment compatibility and troubleshooting.
- [Configuration & usage](docs/configuration.md): Telegram integration, access permissions and advanced configuration.
- [Local storage locations](docs/local-storage.md): choosing and inspecting file save directories.
- [Releases](https://github.com/hicocos/tg-vault/releases): new features and fixes.

---

## 📂 Project Structure

```text
TG Vault/
├── frontend/           # React web frontend
├── backend/            # Node.js API and Telegram service
├── init.sql            # Database initialization script
├── docker-compose.yml  # Docker Compose deployment configuration
├── .env.example        # Environment variable template
└── LICENSE             # MIT License
```

---

## 📄 License

Open-sourced under the [MIT License](LICENSE).

Author: [hicocos](https://github.com/hicocos) · Repository: [hicocos/tg-vault](https://github.com/hicocos/tg-vault)

---

## 📊 Project Data

<div align="center">
  <a href="https://www.star-history.com/#hicocos/tg-vault&amp;type=date&amp;legend=top-left">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=hicocos/tg-vault&amp;type=date&amp;legend=top-left&amp;theme=dark" />
      <img alt="TG Vault Star History Chart" src="https://api.star-history.com/svg?repos=hicocos/tg-vault&amp;type=date&amp;legend=top-left" />
    </picture>
  </a>
</div>
