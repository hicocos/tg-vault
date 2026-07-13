#!/usr/bin/env bash
set -euo pipefail

BACKUP=${1:-}
if [[ -z "$BACKUP" || ! -d "$BACKUP" ]]; then
  echo "用法：$0 ./backups/<timestamp>" >&2
  exit 1
fi

for file in postgres.dump file-storage.tar.gz manifest.txt; do
  [[ -s "$BACKUP/$file" ]] || { echo "缺少或为空：$BACKUP/$file" >&2; exit 1; }
done

(
  cd "$BACKUP"
  expected=$(grep -E '^[0-9a-f]{64}  ' manifest.txt || true)
  [[ -n "$expected" ]] || { echo "manifest 中没有 SHA-256" >&2; exit 1; }
  printf '%s\n' "$expected" | sha256sum -c -
)

docker run --rm -v "$(realpath "$BACKUP"):/backup:ro" postgres:16-alpine \
  pg_restore -l /backup/postgres.dump >/dev/null

docker run --rm -v "$(realpath "$BACKUP"):/backup:ro" alpine:3.20 \
  tar -tzf /backup/file-storage.tar.gz >/dev/null

echo "备份格式、清单和归档校验通过。"
echo "下一步：在隔离的 Compose project/volume 中恢复，并验证数据库行数、密钥解密和 /readyz；本脚本不会写入生产卷。"
