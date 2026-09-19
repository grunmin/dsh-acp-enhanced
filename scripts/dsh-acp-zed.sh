#!/bin/bash
# Zed launcher for dsh-acp-enhanced.
#
# Zed (a GUI app) spawns agent processes with a minimal PATH that usually does
# NOT include node or dsh, so this wrapper locates both itself:
#   - node: PATH, /opt/homebrew/bin, /usr/local/bin, ~/.nvm/versions/node/*
# and prepends the node dir to PATH so dsh's `#!/usr/bin/env node` shebang
# resolves.
#
# dsh CLI resolution (ecosystem order, cf. the DSH_PATH convention):
#   1. $DSH_PATH — an explicit dsh binary, or a directory whose
#      node_modules/.bin/dsh holds one
#   2. the package-local CLI: <pkg>/node_modules/.bin/dsh (this package's
#      @deepseek-ai/dsh devDependency — the version the bridge tracks)
#   3. global fallback: PATH, the npx cache (~/.npm/_npx/*/node_modules/.bin),
#      the global npm prefix bin dir, /opt/homebrew/bin, /usr/local/bin
#
# The home is NEVER rewritten. The launcher boots the profile inside the dsh
# home it was started with (`${DSH_HOME:-$HOME/.dsh}`), so the ACP profile is
# just another profile in that home: it shares credentials, settings, sessions
# and presets with `dsh web`. The CLI it resolves decides *which dsh* runs,
# never *which home* it runs against. To point the launcher at an isolated home,
# export DSH_HOME yourself (Zed: `agent_servers.env`) and bootstrap that home
# with scripts/init-acp-home.sh.
#
# Generation drift is warned about, not hidden: $DSH_HOME/profiles/node_modules
# is one dependency closure shared by every profile under that home, and dsh
# heals it to whichever CLI booted last. Booting this profile with one CLI
# generation while another profile (e.g. `dsh web`) runs under the same home
# lets that process lazily resolve mismatched modules mid-flight, so the
# launcher prints a stderr warning when the closure disagrees with the CLI it
# is about to boot.
#
# The profile resolves DEEPSEEK_API_KEY through the dsh credentials service
# ($DSH_HOME/.credentials.yaml), so no environment plumbing is required; an
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

# The package root: resolve this script through symlinks (the profile links this
# package from the repo) with pwd -P, so the pinned CLI is found even when the
# launcher is reached via node_modules/.
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

DASH_BIN=""
if [ -n "${DSH_PATH:-}" ]; then
  # 1. Explicit override: a dsh binary, or a directory containing one under
  # node_modules/.bin (e.g. a dsh checkout).
  if [ -x "${DSH_PATH}" ]; then
    DASH_BIN="${DSH_PATH}"
  elif [ -x "${DSH_PATH}/node_modules/.bin/dsh" ]; then
    DASH_BIN="${DSH_PATH}/node_modules/.bin/dsh"
  else
    echo "dsh-acp-zed: DSH_PATH is set but holds no dsh ('${DSH_PATH}')" >&2
    exit 127
  fi
elif [ -x "${REPO_DIR}/node_modules/.bin/dsh" ]; then
  # 2. Package-local CLI (this package's devDependency).
  DASH_BIN="${REPO_DIR}/node_modules/.bin/dsh"
else
  # 3. Global fallback.
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
fi
if [ -z "${NODE_BIN}" ] || [ -z "${DASH_BIN}" ]; then
  echo "dsh-acp-zed: cannot locate node and/or dsh (node='${NODE_BIN}' dsh='${DASH_BIN}'); install them or set PATH" >&2
  exit 127
fi

# The home and profile this launcher boots. Computed from the environment — no
# path climbing, so a `link:` checkout and an installed tarball behave alike.
# DSH_ACP_PROFILE_DIR stays an explicit override.
PROFILE_NAME="${DSH_ACP_PROFILE:-acp-enhanced}"
EFFECTIVE_HOME="${DSH_HOME:-$HOME/.dsh}"
export DSH_ACP_PROFILE_DIR="${DSH_ACP_PROFILE_DIR:-$EFFECTIVE_HOME/profiles/$PROFILE_NAME}"

# Guard the missing profile: booting a home without the bridge installed starts
# an agent stack that never speaks ACP on stdio, which Zed reports as an opaque
# hang. Point at the setup command instead.
if [ ! -d "${DSH_ACP_PROFILE_DIR}" ]; then
  echo "dsh-acp-zed: profile '${PROFILE_NAME}' not found at '${DSH_ACP_PROFILE_DIR}' (dsh home '${EFFECTIVE_HOME}')" >&2
  echo "  Create it with: ${DASH_BIN} plugin --profile ${PROFILE_NAME} add link:${REPO_DIR}" >&2
  echo "  Or bootstrap an isolated home with: ${REPO_DIR}/scripts/init-acp-home.sh" >&2
  exit 127
fi

# Generation drift between the shared closure and the booting CLI (see header).
CLOSURE_MANIFEST="${EFFECTIVE_HOME}/profiles/node_modules/@deepseek-ai/dsh-agent/package.json"
if [ -f "${CLOSURE_MANIFEST}" ]; then
  CLOSURE_VERSION="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${CLOSURE_MANIFEST}" | head -n 1)"
  CLI_VERSION="$("${DASH_BIN}" --version 2>/dev/null | head -n 1 | tr -d '[:space:]')"
  if [ -n "${CLOSURE_VERSION}" ] && [ -n "${CLI_VERSION}" ] && [ "${CLOSURE_VERSION}" != "${CLI_VERSION}" ]; then
    echo "dsh-acp-zed: warning: ${EFFECTIVE_HOME}/profiles/node_modules holds dsh-agent ${CLOSURE_VERSION}, but ${DASH_BIN} is ${CLI_VERSION}." >&2
    echo "  The closure heals to the booting CLI on this boot; restart every other dsh process under this home (e.g. 'dsh web') afterwards." >&2
  fi
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

exec "${DASH_BIN}" --profile "${PROFILE_NAME}" "$@"
