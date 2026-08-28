#!/bin/bash
# Zed launcher for dsh-acp-enhanced.
#
# Zed (a GUI app) spawns agent processes with a minimal PATH that usually does
# NOT include node or dsh, so this wrapper locates both itself:
#   - node: PATH, /opt/homebrew/bin, /usr/local/bin, ~/.nvm/versions/node/*
#   - dsh:  PATH, the npx cache (~/.npm/_npx/*/node_modules/.bin), the global
#           npm prefix bin dir, /opt/homebrew/bin, /usr/local/bin
# and prepends the node dir to PATH so dsh's `#!/usr/bin/env node` shebang
# resolves.
#
# The profile resolves DEEPSEEK_API_KEY through the dsh credentials service
# (~/.dsh/.credentials.yaml), so no environment plumbing is required; an
# explicit DEEPSEEK_API_KEY from Zed's agent_servers.env wins, and a running
# `dsh web` process is a final fallback source.
#
# stdout stays the ACP JSON-RPC wire; diagnostics go to stderr.
set -u

NODE_BIN="$(command -v node 2>/dev/null || true)"
if [ -z "${NODE_BIN}" ]; then
  for candidate in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    "$HOME"/.nvm/versions/node/*/bin/node; do
    if [ -x "${candidate}" ]; then
      NODE_BIN="${candidate}"
      break
    fi
  done
fi
if [ -n "${NODE_BIN}" ]; then
  export PATH="$(dirname "${NODE_BIN}"):${PATH}"
fi

DASH_BIN="$(command -v dsh 2>/dev/null || true)"
if [ -z "${DASH_BIN}" ]; then
  for candidate in \
    "$HOME"/.npm/_npx/*/node_modules/.bin/dsh \
    "$(npm prefix -g 2>/dev/null)/bin/dsh" \
    /opt/homebrew/bin/dsh \
    /usr/local/bin/dsh; do
    if [ -x "${candidate}" ]; then
      DASH_BIN="${candidate}"
      break
    fi
  done
fi
if [ -z "${NODE_BIN}" ] || [ -z "${DASH_BIN}" ]; then
  echo "dsh-acp-zed: cannot locate node and/or dsh (node='${NODE_BIN}' dsh='${DASH_BIN}'); install them or set PATH" >&2
  exit 127
fi

if [ -z "${DEEPSEEK_API_KEY:-}" ]; then
  WEB_PID="$(pgrep -f 'dsh web' | head -n 1)"
  if [ -n "${WEB_PID}" ]; then
    KEY="$(ps eww "${WEB_PID}" 2>/dev/null | tr ' ' '\n' | grep '^DEEPSEEK_API_KEY=' | cut -d= -f2-)"
    if [ -n "${KEY}" ]; then
      export DEEPSEEK_API_KEY="${KEY}"
    fi
  fi
fi

# Derive the profile root from this launcher's own location:
#   …/profiles/<name>/node_modules/<pkg>/scripts/dsh-acp-zed.sh
# — three levels above this script is the profile dir. pwd -L keeps the
# logical path (pnpm lays out node_modules as symlinks), so the climb lands
# on the profile root. The bridge persists small per-model state (the last
# reasoning effort per model) next to the profile's own files.
if [ -z "${DSH_ACP_PROFILE_DIR:-}" ]; then
  ACP_LAUNCHER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -L)"
  export DSH_ACP_PROFILE_DIR="$(cd "${ACP_LAUNCHER_DIR}/../../.." && pwd -L)"
fi

exec "${DASH_BIN}" --profile acp-enhanced "$@"
