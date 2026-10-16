#!/usr/bin/env bash
# Runtime checks are intentionally independent of .env creation.
installer_compose() {
  env SOURCE_REVISION="$RELEASE_REVISION" SOURCE_VERSION="$RELEASE_VERSION" docker compose ${INSTALL_COMPOSE_ARGS[@]+"${INSTALL_COMPOSE_ARGS[@]}"} "$@"
}

prepare_install_compose() {
  INSTALL_COMPOSE_ARGS=()
  INSTALL_COMPAT_FILE=''
  INSTALL_SOURCE_IMAGE_FILE=''
  trap 'rm -f "${INSTALL_COMPAT_FILE:-}" "${INSTALL_SOURCE_IMAGE_FILE:-}"' EXIT
}

prepare_source_build() {
  local override
  if [[ -n "${COMPOSE_FILE:-}" ]]; then
    echo "源码兜底不支持 COMPOSE_FILE；请使用项目的标准 Compose 配置。" >&2
    return 1
  fi
  for override in compose.override.yaml compose.override.yml docker-compose.override.yml docker-compose.override.yaml; do
    if [[ -f "$override" ]]; then
      echo "源码兜底检测到额外 Compose 覆盖文件；为保护自定义配置，已停止自动切换。" >&2
      return 1
    fi
  done
  INSTALL_COMPOSE_ARGS=(--project-directory "$PWD" --env-file "$PWD/.env" -f "$PWD/docker-compose.yml")
  if [[ "${INSTALL_REQUIRE_ATTESTATIONS:-true}" == false ]]; then
    INSTALL_COMPAT_FILE="$(mktemp "${TMPDIR:-/tmp}/tg-vault-build-compat.XXXXXX.yml")"
    python3 - "$PWD/docker-compose.build.yml" "$INSTALL_COMPAT_FILE" <<'PY'
from pathlib import Path
import re, sys
source, target = map(Path, sys.argv[1:])
target.write_text(''.join(line for line in source.read_text().splitlines(keepends=True)
                          if not re.match(r'^      (sbom|provenance):', line)))
PY
    INSTALL_COMPOSE_ARGS+=(-f "$INSTALL_COMPAT_FILE")
  else
    INSTALL_COMPOSE_ARGS+=(-f "$PWD/docker-compose.build.yml")
  fi
  INSTALL_SOURCE_IMAGE_FILE="$(mktemp "${TMPDIR:-/tmp}/tg-vault-source-images.XXXXXX.yml")"
  python3 - "$INSTALL_SOURCE_IMAGE_FILE" "$$" <<'PY'
import json, sys
from pathlib import Path
Path(sys.argv[1]).write_text(json.dumps({'services': {
    service: {'image': f'tg-vault-{service}:source-{sys.argv[2]}'}
    for service in ('backend', 'frontend')}}))
PY
  INSTALL_COMPOSE_ARGS+=(-f "$INSTALL_SOURCE_IMAGE_FILE")
}

verify_application_image_pair() {
  local service image expected='' revision
  for service in backend frontend; do
    image="$(installer_compose config --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["services"][sys.argv[1]]["image"])' "$service")"
    revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" || return 1
    if [[ ! "$revision" =~ ^[0-9a-f]{40}$ ]]; then
      echo "镜像缺少有效源码修订，不能确认前后端属于同一发布。" >&2
      return 1
    fi
    if [[ -n "$expected" && "$revision" != "$expected" ]]; then
      echo "前后端 latest 镜像修订不一致，暂不替换线上服务。" >&2
      return 1
    fi
    expected="$revision"
  done
}

build_application_images() {
  echo '切换到本地源码构建；数据库、文件挂载和已有密钥保持不变。'
  INSTALL_STAGE=source-environment
  INSTALL_CHECK_BUILD=true check_environment
  prepare_source_build
  installer_compose config --quiet
  installer_compose config --format json | python3 "$SCRIPT_DIR/install-storage.py" verify
  INSTALL_STAGE=build-backend
  installer_compose build backend
  INSTALL_STAGE=build-frontend
  installer_compose build frontend
}

assert_database_credentials_safe() {
  # Inspect only. Existing data must never receive a newly generated password.
  local password="$1" project volume containers
  [[ -n "$password" ]] && return 0
  project="${COMPOSE_PROJECT_NAME:-tg-vault}"
  volume="${project}_postgres-data"
  containers="$(docker ps -aq --filter "label=com.docker.compose.project=$project" --filter 'label=com.docker.compose.service=postgres')"
  if [[ -n "$containers" ]] || docker volume inspect "$volume" >/dev/null 2>&1; then
    echo "检测到已有 PostgreSQL 容器或数据卷，但 .env 缺少 DB_PASSWORD。" >&2
    echo "已停止，避免新密码导致数据库无法登录。请恢复原 .env/数据库密码后重试，不要删除数据卷。" >&2
    return 1
  fi
}

installer_failure() {
  local status="$1"
  trap - ERR
  echo "TG Vault 部署失败（阶段：${INSTALL_STAGE:-unknown}，退出码：$status）。" >&2
  echo "未自动删除数据卷或重置密码。排障请运行：" >&2
  echo "  docker compose ps --all" >&2
  echo "  docker compose logs --tail=80 postgres backend frontend" >&2
  installer_compose ps --all >&2 || true
  exit "$status"
}

validate_install_timeout() {
  local timeout="${INSTALL_HEALTH_TIMEOUT:-180}"
  if [[ ! "$timeout" =~ ^[1-9][0-9]{1,3}$ ]] || (( timeout < 30 || timeout > 1800 )); then
    echo "INSTALL_HEALTH_TIMEOUT 必须为 30–1800 秒的整数。" >&2
    return 1
  fi
}

start_installation() {
  local timeout="${INSTALL_HEALTH_TIMEOUT:-180}"
  validate_install_timeout
  trap 'installer_failure $?' ERR
  INSTALL_STAGE=config
  installer_compose config --quiet
  installer_compose config --format json | python3 "$SCRIPT_DIR/install-storage.py" verify
  if [[ "${INSTALL_FROM_SOURCE:-false}" == true ]]; then
    build_application_images
  else
    INSTALL_STAGE=pull-application
    echo '正在拉取 GHCR 最新前后端镜像（latest）...'
    if installer_compose pull backend frontend && verify_application_image_pair; then
      echo '最新镜像拉取完成；无需在本机编译。'
    else
      echo '镜像拉取失败、架构不支持或发布不完整，使用本地源码兜底。' >&2
      build_application_images
    fi
  fi
  INSTALL_STAGE=postgres
  # The first install MUST start its dependency. Existing database containers are
  # never recreated for an application upgrade; stopped ones may be started.
  installer_compose up -d --no-build --no-deps --no-recreate --wait --wait-timeout "$timeout" postgres
  INSTALL_STAGE=application
  installer_compose up -d --no-build --pull never --no-deps --wait --wait-timeout "$timeout" backend frontend
  INSTALL_STAGE=verify
  installer_compose ps
  trap - ERR
}
