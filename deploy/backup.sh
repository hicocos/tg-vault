#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f docker-compose.yml ]]; then
  echo "请从包含 docker-compose.yml 的项目目录运行。" >&2
  exit 1
fi

BACKUP_ROOT=${BACKUP_DIR:-./backups}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DEST="$BACKUP_ROOT/$STAMP"
mkdir -p "$DEST"

DB_FILE="$DEST/postgres.dump"
DATA_FILE="$DEST/file-storage.tar.gz"

docker compose exec -T postgres pg_dump -U tgvault -d tgvault -Fc > "$DB_FILE"
docker run --rm \
  -v tg-vault_file-storage:/data:ro \
  -v "$(realpath "$DEST"):/backup" \
  alpine:3.20 sh -c 'tar -C /data -czf /backup/file-storage.tar.gz .'

{
  echo "created_at=$STAMP"
  echo "git_revision=$(git rev-parse HEAD 2>/dev/null || echo unknown)"
  echo "compose_services=$(docker compose config --services | tr '\n' ',')"
  sha256sum "$DB_FILE" "$DATA_FILE"
} > "$DEST/manifest.txt"

chmod -R go-rwx "$DEST"
echo "备份已创建：$DEST"
echo "该目录包含数据库与密钥材料，请加密并复制到异地存储。"
