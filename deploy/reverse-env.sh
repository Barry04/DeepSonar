#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
用法：reverse-env.sh --check

deepsonar-reverse 提供钉死的 REA CLI + Ghidra 12.1.4 + 完整 JDK 21，用于 ELF/.so/PE 深度静态分析。
CLI-only：不注册 MCP、不安装 Hopper/IDA、不启动常驻 REA 服务。不改变全局默认镜像。
USAGE
}

semver_ge() {
  # return 0 if $1 >= $2 (major.minor.patch)
  local a="$1" b="$2"
  IFS=. read -r a1 a2 a3 <<<"${a%%[-+]*}"
  IFS=. read -r b1 b2 b3 <<<"${b%%[-+]*}"
  a1=${a1:-0}; a2=${a2:-0}; a3=${a3:-0}
  b1=${b1:-0}; b2=${b2:-0}; b3=${b3:-0}
  if (( a1 != b1 )); then (( a1 > b1 )); return; fi
  if (( a2 != b2 )); then (( a2 > b2 )); return; fi
  (( a3 >= b3 ))
}

check_manifest() {
  [[ -s /opt/deepsonar/tool-manifest.json ]]
  jq -e '
    .contract == "deepsonar.runtime.contract/v1" and
    .imageKey == "deepsonar-reverse" and
    .toolset == "reverse" and
    .project_opt_in == true and
    (.tools | index("rea")) and
    (.tools | index("analyzeHeadless")) and
    (.tools | index("java")) and
    .ghidra.install_dir == "/opt/deepsonar/ghidra" and
    .ghidra.version == "12.1.4" and
    .rea.version == "6.4.0"
  ' /opt/deepsonar/tool-manifest.json >/dev/null
}

check_tools() {
  local command_name
  for command_name in java javac rea rea-agents analyzeHeadless jq node; do
    command -v "$command_name" >/dev/null 2>&1 || {
      printf 'reverse 环境检查失败：缺少命令 %s\n' "$command_name" >&2
      return 1
    }
  done

  [[ -n "${JAVA_HOME:-}" && -x "${JAVA_HOME}/bin/java" ]] || {
    printf 'reverse 环境检查失败：JAVA_HOME 无效\n' >&2
    return 1
  }
  [[ -n "${GHIDRA_INSTALL_DIR:-}" && -x "${GHIDRA_INSTALL_DIR}/support/analyzeHeadless" ]] || {
    printf 'reverse 环境检查失败：GHIDRA_INSTALL_DIR 无效\n' >&2
    return 1
  }

  local java_ver node_ver rea_ver
  java_ver="$(java -version 2>&1 | head -n1 || true)"
  [[ "$java_ver" == *'"21.'* || "$java_ver" == *' version "21'* ]] || {
    printf 'reverse 环境检查失败：需要完整 JDK 21，实际：%s\n' "$java_ver" >&2
    return 1
  }

  node_ver="$(node -p "process.versions.node")"
  semver_ge "$node_ver" "22.19.0" || {
    printf 'reverse 环境检查失败：需要 Node >= 22.19.0，实际：%s\n' "$node_ver" >&2
    return 1
  }

  node -e 'const p=require("/opt/deepsonar/rea/node_modules/rea-agents/package.json"); if (p.version !== "6.4.0") { console.error(p.version); process.exit(1); }' || {
    printf 'reverse 环境检查失败：rea-agents 版本不是 6.4.0\n' >&2
    return 1
  }

  # Forbidden surfaces in this image
  for command_name in hopper ida64 ida mcp-server ghidraRun; do
    if command -v "$command_name" >/dev/null 2>&1; then
      printf 'reverse 运行时不得预装/暴露 %s\n' "$command_name" >&2
      return 1
    fi
  done

  check_manifest
}

main() {
  case "${1:-}" in
    --check) check_tools; printf 'reverse-env check ok\n' ;;
    -h|--help) usage ;;
    *) usage >&2; exit 2 ;;
  esac
}

main "$@"
