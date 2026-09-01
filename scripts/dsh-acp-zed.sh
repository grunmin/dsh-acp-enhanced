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
#   2. the repo-pinned CLI: <repo>/node_modules/.bin/dsh (this package's
#      @deepseek-ai/dsh devDependency — the version the bridge tracks)
#   3. global fallback: PATH, the npx cache (~/.npm/_npx/*/node_modules/.bin),
#      the global npm prefix bin dir, /opt/homebrew/bin, /usr/local/bin
#
# Isolated DSH_HOME: dsh heals its whole dependency closure into
# $DSH_HOME/profiles/node_modules on every boot — a dir shared by every
# profile under that home, whose content flips to whichever CLI booted last.
# A second CLI generation under one home would let a running profile (e.g.
# `dsh web`) lazily resolve mismatched module versions mid-process. So
# whenever (1) or (2) resolves the CLI, this launcher boots the profile under
# its own home: DSH_HOME=${DSH_ACP_HOME:-$HOME/.dsh-acp} (exported only when
# DSH_HOME is not already set). The default home and the global `dsh web`
# stack stay untouched; the global fallback (3) keeps the default home and
# the pre-existing profile there, so a fresh clone without `pnpm install`
# degrades to the legacy behavior. Create the isolated-home profile once with
# scripts/init-acp-home.sh.
#
# The profile resolves DEEPSEEK_API_KEY through the dsh credentials service
# (~/.dsh/.credentials.yaml — copied into the isolated home by the same
# script), so no environment plumbing is required; an explicit
# DEEPSEEK_API_KEY from Zed's agent_servers.env wins, and a running `dsh web`
# process is a final fallback source.
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

# The repo root: resolve this script through symlinks (the profile links this
# package from the repo) with pwd -P, so the pinned CLI is found even when
# the launcher is reached via node_modules/.
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

DASH_BIN=""
DSH_SOURCE=""
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
  DSH_SOURCE="dshpath"
elif [ -x "${REPO_DIR}/node_modules/.bin/dsh" ]; then
  # 2. Repo-pinned CLI (this package's devDependency).
  DASH_BIN="${REPO_DIR}/node_modules/.bin/dsh"
  DSH_SOURCE="repo"
else
  # 3. Global fallback (legacy resolution).
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
  DSH_SOURCE="global"
fi
if [ -z "${NODE_BIN}" ] || [ -z "${DASH_BIN}" ]; then
  echo "dsh-acp-zed: cannot locate node and/or dsh (node='${NODE_BIN}' dsh='${DASH_BIN}'); install them or set PATH" >&2
  exit 127
fi

# The isolated home applies whenever the CLI came from DSH_PATH or the repo
# pin — never for the global fallback, which shares the default home with the
# rest of the machine. An exported DSH_HOME is honored only when it points
# AWAY from the default home: harness processes inject DSH_HOME=$HOME/.dsh
# into every child (agents, tools), and honoring that inherited value here
# would boot the pinned CLI against the shared default home — flipping its
# module-fallback closure under a running profile. To force the pinned CLI
# onto the default home deliberately, set DSH_ACP_HOME=$HOME/.dsh.
ISOLATED_HOME=0
if [ "${DSH_SOURCE}" != "global" ]; then
  ISOLATED_HOME=1
  if [ -z "${DSH_HOME:-}" ] || [ "${DSH_HOME}" = "$HOME/.dsh" ]; then
    export DSH_HOME="${DSH_ACP_HOME:-$HOME/.dsh-acp}"
  fi
fi

# Guard the isolated-home path: booting a profile without the bridge installed
# would start an agent stack that never speaks ACP on stdio, which Zed reports
# as an opaque hang. Point at the one-shot setup script instead.
if [ "${ISOLATED_HOME}" = 1 ] && [ ! -d "${DSH_HOME}/profiles/acp-enhanced" ]; then
  echo "dsh-acp-zed: profile 'acp-enhanced' missing under the isolated home '${DSH_HOME}'; bootstrap it once with: ${REPO_DIR}/scripts/init-acp-home.sh" >&2
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
  if [ "${ISOLATED_HOME}" = 1 ]; then
    export DSH_ACP_PROFILE_DIR="${DSH_HOME}/profiles/acp-enhanced"
  else
    ACP_LAUNCHER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -L)"
    export DSH_ACP_PROFILE_DIR="$(cd "${ACP_LAUNCHER_DIR}/../../.." && pwd -L)"
  fi
fi

exec "${DASH_BIN}" --profile acp-enhanced "$@"
