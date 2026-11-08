#!/usr/bin/env bash
set -Eeuo pipefail

main() {
  if (( BASH_VERSINFO[0] < 4 )); then
    printf '需要 Bash 4 或更新版本，请不要使用 sh 运行。\n' >&2
    exit 2
  fi

  local argument non_interactive=false install_dir
  for argument in "$@"; do
    case "$argument" in
      --non-interactive) non_interactive=true ;;
      --skip-source-update|--build|--compat) ;;
      -h|--help)
        cat <<'EOF'
用法：bash install.sh [--non-interactive] [--skip-source-update] [--build] [--compat]

自动下载 TG Vault 并运行安装向导，需要 Bash 4+ 和 Git。
默认下载到当前目录下的 tg-vault；在项目根目录运行时复用当前项目。
可通过 TG_VAULT_INSTALL_DIR 指定项目目录，已有项目交由原安装器更新。
所有参数原样传给 deploy/install.sh；--non-interactive 不读取终端输入。
EOF
        exit 0
        ;;
      *)
        printf '未知参数：%s；使用 --help 查看用法。\n' "$argument" >&2
        exit 2
        ;;
    esac
  done

  if [[ "$non_interactive" == false && ! -t 0 ]]; then
    if ! { exec < /dev/tty; } 2>/dev/null; then
      printf '当前没有交互式终端；请在终端中运行，或使用 --non-interactive。\n' >&2
      exit 2
    fi
  fi

  if ! command -v git >/dev/null 2>&1; then
    printf '一键入口需要 Git，请先安装 Git；其余依赖由安装向导检查。\n' >&2
    exit 1
  fi

  install_dir="${TG_VAULT_INSTALL_DIR:-}"
  if [[ -z "$install_dir" ]]; then
    if [[ -e .git && -f deploy/install.sh && -f docker-compose.yml ]]; then
      install_dir="$PWD"
    else
      install_dir="$PWD/tg-vault"
    fi
  fi

  if [[ -e "$install_dir/.git" && -f "$install_dir/deploy/install.sh" && -f "$install_dir/docker-compose.yml" ]]; then
    printf '使用已有项目：%s\n' "$install_dir"
  elif [[ ! -e "$install_dir" ]]; then
    printf '正在下载 TG Vault：%s\n' "$install_dir"
    GIT_TERMINAL_PROMPT=0 git clone --depth 1 --branch main -- https://github.com/hicocos/tg-vault.git "$install_dir"
  else
    printf '目标目录已存在且不是 TG Vault 源码目录：%s\n请通过 TG_VAULT_INSTALL_DIR 指定其他目录。\n' "$install_dir" >&2
    exit 1
  fi

  cd -- "$install_dir"
  exec bash ./deploy/install.sh "$@"
}

main "$@"
