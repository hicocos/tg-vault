#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d /tmp/tg-vault-backup-test.XXXXXX)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/backups"
cat > "$TMP/bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${DOCKER_CALLS:?}"
if [[ "$1 $2 $3" == "compose ps -q" ]]; then
  echo backend-container
elif [[ "$1" == inspect && "$2" == --format=* ]]; then
  echo test_file-storage
elif [[ "$1 $2" == "compose stop" ]]; then
  if [[ -n "${DOCKER_STOP_SIGNAL:-}" ]]; then
    kill -s "$DOCKER_STOP_SIGNAL" "$PPID"
  fi
  [[ "${DOCKER_STOP_FAIL:-0}" != 1 ]]
elif [[ "$1 $2 $3" == "compose config --services" ]]; then
  printf 'postgres\nbackend\nfrontend\n'
elif [[ "$*" == *"psql"* && "$*" == *"pg_database_size"* ]]; then
  printf '1024\n'
elif [[ "$1 $2 $3" == "compose exec -T" ]]; then
  printf 'valid-dump-placeholder'
elif [[ "$1" == run ]]; then
  mount=''
  for ((i=1; i<=$#; i++)); do
    arg=${!i}
    if [[ "$arg" == *:/backup* ]]; then mount=${arg%%:/backup*}; fi
  done
  if [[ "$*" == *"du -sb /data"* ]]; then
    printf '2048\t/data\n'
  elif [[ "$*" == *"pg_restore -l /backup/postgres.dump"* ]]; then
    [[ -s "$mount/postgres.dump" ]]
  elif [[ "$*" == *"tar -tzf /backup/file-storage.tar.gz"* ]]; then
    tar -tzf "$mount/file-storage.tar.gz" >/dev/null
  elif [[ "$*" == *"tar -C /data -czf /backup/file-storage.tar.gz"* ]]; then
    tar -czf "$mount/file-storage.tar.gz" --files-from /dev/null
  fi
fi
SH
chmod +x "$TMP/bin/docker"
export PATH="$TMP/bin:$PATH"
export DOCKER_CALLS="$TMP/docker.calls"

(
  cd "$ROOT"
  BACKUP_DIR="$TMP/backups" ./deploy/backup.sh
)
BACKUP=$(find "$TMP/backups" -mindepth 1 -maxdepth 1 -type d -print -quit)
[[ -n "$BACKUP" ]]
(
  cd "$ROOT"
  ./deploy/restore-verify.sh "$BACKUP"
)
cp "$DOCKER_CALLS" "$TMP/success.calls"

# A deliberately impossible free-space report must fail before stopping backend.
: > "$DOCKER_CALLS"
set +e
(
  cd "$ROOT"
  BACKUP_DIR="$TMP/too-small" BACKUP_AVAILABLE_BYTES_OVERRIDE=1024 BACKUP_MIN_FREE_BYTES=0 ./deploy/backup.sh
) >/dev/null 2>&1
space_code=$?
set -e
[[ "$space_code" -ne 0 ]]
! grep -q 'compose stop .*backend' "$DOCKER_CALLS"

# A stop command may return non-zero after stopping backend; it must still be restarted.
: > "$DOCKER_CALLS"
set +e
(
  cd "$ROOT"
  BACKUP_DIR="$TMP/stop-failure" DOCKER_STOP_FAIL=1 ./deploy/backup.sh
) >/dev/null 2>&1
stop_code=$?
set -e
[[ "$stop_code" -ne 0 ]]
grep -q 'compose stop .*backend' "$DOCKER_CALLS"
grep -q 'compose start backend' "$DOCKER_CALLS"

# INT/TERM during stop must also restart backend exactly once.
for signal in INT TERM; do
  : > "$DOCKER_CALLS"
  set +e
  (
    cd "$ROOT"
    BACKUP_DIR="$TMP/stop-signal-$signal" DOCKER_STOP_SIGNAL="$signal" ./deploy/backup.sh
  ) >/dev/null 2>&1
  signal_code=$?
  set -e
  [[ "$signal_code" -ne 0 ]]
  grep -q 'compose stop .*backend' "$DOCKER_CALLS"
  [[ $(grep -c 'compose start backend' "$DOCKER_CALLS") -eq 1 ]]
done

# Continue assertions for the successful backup above.
grep -q '^consistency=backend-stopped$' "$BACKUP/manifest.txt"
grep -Eq '^[0-9a-f]{64}  postgres\.dump$' "$BACKUP/manifest.txt"
grep -Eq '^[0-9a-f]{64}  file-storage\.tar\.gz$' "$BACKUP/manifest.txt"
stop_line=$(grep -n 'compose stop .*backend' "$TMP/success.calls" | head -1 | cut -d: -f1)
dump_line=$(grep -n 'compose exec -T postgres pg_dump' "$TMP/success.calls" | head -1 | cut -d: -f1)
tar_line=$(grep -n 'tar -C /data -czf /backup/file-storage.tar.gz' "$TMP/success.calls" | head -1 | cut -d: -f1)
start_line=$(grep -n 'compose start backend' "$TMP/success.calls" | head -1 | cut -d: -f1)
[[ "$stop_line" -lt "$dump_line" && "$dump_line" -lt "$tar_line" && "$tar_line" -lt "$start_line" ]]
echo 'backup/restore coordinated snapshot test ok'
