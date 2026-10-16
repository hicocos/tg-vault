# 本地文件保存位置

[首页](../README.md) · [部署指南](../deploy/DEPLOY.md) · [配置参考](configuration.md)

## 全新安装

`deploy/install.sh` 询问服务器保存目录，默认 `<项目目录>/data`。文件保存在服务器而非浏览器所在电脑；可选另一块已挂载磁盘下的新专用目录，如 `/mnt/archive/tg-vault-data`。非交互安装通过 `INSTALL_STORAGE_PATH` 指定。

- 目录必须尚不存在，上级目录已存在；安装器创建权限 `0700`、所有者 UID/GID `1000:1000`，不递归修改其他目录。
- 仅支持绝对路径中的 ASCII 字母、数字、空格、`/`、`-`、`_`、`.`，拒绝 `..`、符号链接、系统/磁盘根目录及特殊字符。权限不足时按安装器提示使用 sudo。
- 目录映射到容器 `/data`；原文件在 `uploads` 子目录，缩略图、预览、分片、session 和密钥也在该持久目录下。不要只备份 uploads。
- **不要预先复制 `.env.example`**，已有 `.env` 会被当作旧部署，不应用新的目录默认值。

## 已有部署

升级保留原挂载，**不自动迁移文件**。Compose 未配置 `LOCAL_STORAGE_SOURCE` 时仍使用历史 `file-storage` named volume。安装器核对现有 backend 的实际 `/data` 挂载与 Compose；不一致即停止，不用新默认目录遮蔽旧数据。

保留原 `.env` 与自定义挂载。只有 `.env`、没有旧容器时，也需要原目录或卷存在；丢失部署配置不能从文件名推断原挂载。不要通过修改 `UPLOAD_DIR` 或 `LOCAL_STORAGE_SOURCE` 尝试移动数据。

确需换盘或搬迁时，先做协调备份，在维护窗口停止写入，将**完整 `/data`** 连同数据库、原密钥恢复到已确认的新目标，保留 UID/GID 与权限；同步挂载和展示元数据，在隔离环境验证后切换。不要向运行中的目录复制覆盖，也不要提前删除原卷。具体恢复流程见[部署指南](../deploy/DEPLOY.md#7-备份与恢复)。

## Web 路径展示

**设置 → 存储** 的本地卡片展示可复制的服务器文件路径、可写状态与实际文件系统剩余空间。剩余容量与其他应用共享，不表示 TG Vault 的专用配额。Web 不提供路径修改或迁移。

应用不访问 Docker socket。管理员可在宿主机读取实际挂载：

```bash
docker inspect --format '{{json .Mounts}}' tg-vault-backend
```

找到 `Destination=/data`，核对 `Type`、`Source` 与 `RW`。需要为已有挂载补充展示信息时，使用真实 Source 路径运行只读命令：

```bash
python3 deploy/install-storage.py metadata /actual/host/data-root volume
# bind 挂载将最后一个参数改为 bind
```

命令输出 **JSON 对象**。将各字段的值分别保存为原 `.env` 中的 `LOCAL_STORAGE_HOST_ROOT`、`LOCAL_STORAGE_CONTAINER_ROOT`、`LOCAL_STORAGE_DEVICE`、`LOCAL_STORAGE_INODE`、`LOCAL_STORAGE_MOUNT_TYPE`，不要把整段 JSON 直接粘入 `.env`。保留其他配置与秘密，不要因此修改 `LOCAL_STORAGE_SOURCE`。

路径显示校验设备号/inode、真实路径和子目录关系。元数据缺失、过期、符号链接或文件系统不匹配时显示“未确认”。rootless/远程 Docker 或重挂载后标识可能不同，应重新核对实际挂载，不能伪造标识让检查通过；该检查不是对恶意宿主机的信任证明。

## 备份边界

[`deploy/backup.sh`](../deploy/backup.sh) 使用已有 backend 容器的实际挂载，以只读 `--volumes-from` 归档 `/data`，同时备份数据库，兼容 bind 与 named volume。原容器可以停止，但不能不存在；先运行 `docker compose down` 会失去该检查依据。

归档期间 backend 停止，完成或失败后恢复原运行状态。备份位置宜在另一块磁盘，**`.env` 和反向代理配置另行安全备份**。归档含密钥与 Telegram session，必须限制访问、加密并异地保存。远端存储文件需另行备份。

[`deploy/restore-verify.sh`](../deploy/restore-verify.sh) 仅验证清单、校验和及格式，不恢复数据。恢复时将 `file-storage.tar.gz` 解压到目标 `/data` 根，不额外嵌套 uploads；与同一批数据库和原密钥配套恢复，检查文件、权限及 `/readyz` 后再正式切换。

## English summary

Fresh installs ask for a new, dedicated server directory (default: `<installation>/data`). The parent must already exist. The installer creates the directory with mode `0700` and UID/GID `1000:1000`; supported path characters are ASCII letters, digits, spaces, `/`, `-`, `_` and `.`. Symlinks and `..` are rejected. Do not copy `.env.example` before a fresh installer run: an existing `.env` selects the existing-deployment path.

The directory mounts at `/data`; original files live in `/data/uploads`, but backup must include the entire `/data`, the database and `.env`. Existing installations keep their original bind mount or named volume, with no automatic migration. The web card is read-only and displays verified server paths and shared filesystem free space; it does not refer to your browser's computer. Missing or stale path metadata remains unconfirmed.

Backup reads the backend's actual mounts, including a stopped backend; do not remove that container before backup. `.env`, proxy configuration and remote storage objects are not included. Archives contain secrets and sessions: encrypt them and store them off-site. Archive verification is not a restore drill. See the [deployment guide](../deploy/DEPLOY.md#7-备份与恢复) for coordinated backup and isolated recovery.
