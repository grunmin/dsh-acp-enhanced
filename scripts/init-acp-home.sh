#!/bin/bash
# One-shot bootstrap for the isolated dsh home used by the acp-enhanced
# profile (see docs/plans/2026-09-01-dsh-0.1.2-alpha.2-migration.md).
#
# The launcher (scripts/dsh-acp-zed.sh) boots this profile with the
# repo-pinned @deepseek-ai/dsh CLI under its own DSH_HOME (default
# ~/.dsh-acp), because $DSH_HOME/profiles/node_modules is shared by every
# profile under that home and flips to the closure of whichever CLI booted
# last — a second CLI generation must not share it with the machine's default
# home. This script creates that home once:
#
#   1. profile 'acp-enhanced' via `dsh plugin add` (bundles:
#      @deepseek-ai/dsh-base + dsh-acp-enhanced — deliberately WITHOUT
#      dsh-mnemon, which does not support the 0.1.2-alpha harness)
#   2. bundle-set verification (the profile must never carry dsh-mnemon)
#   3. the user-layer cordis.patch.yml: your old profile's user rows ported
#      verbatim (web-search routing and friends — machine-specific values
#      never shipped with this repo), plus the subagent-model-selection host
#      service the 0.1.2-alpha standard preset requires and the DeepSeek
#      plugin-inventory reporter disabled
#   4. credentials + settings from the default home (never overwritten)
#   5. the agent-preset user root, home-layer patch, and the bridge's effort
#      memory, when the default home has them
#
# Re-running is safe: existing files are never clobbered.
set -eu

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
CLI="${REPO_DIR}/node_modules/.bin/dsh"
if [ ! -x "${CLI}" ]; then
  echo "init-acp-home: repo-pinned dsh CLI missing (${CLI}); run 'pnpm install' in ${REPO_DIR} first" >&2
  exit 1
fi

NEW_HOME="${DSH_ACP_HOME:-$HOME/.dsh-acp}"
OLD_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="${NEW_HOME}/profiles/acp-enhanced"
mkdir -p "${NEW_HOME}"
export DSH_HOME="${NEW_HOME}"

echo "==> isolated home: ${NEW_HOME}"
echo "==> default home (source of migrations): ${OLD_HOME}"

# 1. Profile: create when missing, refresh the link when present.
if [ ! -f "${PROFILE_DIR}/package.json" ]; then
  "${CLI}" plugin --profile acp-enhanced add "link:${REPO_DIR}"
else
  echo "==> profile exists; refreshing the repo link"
  "${CLI}" plugin --profile acp-enhanced add "link:${REPO_DIR}" >/dev/null
fi

# 2. Verify the bundle set — reconcilePlugins has been observed re-adding
# disabled plugins, and this profile must not carry dsh-mnemon (its
# dsh-client-runtime import is gone in the 0.1.2-alpha harness).
BAD_BUNDLES="$(python3 -c "
import json
p = json.load(open('${PROFILE_DIR}/package.json'))
bundles = p.get('dsh', {}).get('profile', {}).get('bundles', [])
need = {'@deepseek-ai/dsh-base', 'dsh-acp-enhanced'}
problems = []
missing = need - set(bundles)
if missing:
    problems.append('MISSING:' + ','.join(sorted(missing)))
forbidden = set(bundles) & {'dsh-mnemon'}
if forbidden:
    problems.append('FORBIDDEN:' + ','.join(sorted(forbidden)))
print(' '.join(problems), end='')
")"
if [ -n "${BAD_BUNDLES}" ]; then
  echo "init-acp-home: unexpected bundle set (${BAD_BUNDLES}); fix ${PROFILE_DIR}/package.json by hand" >&2
  exit 1
fi
echo "==> profile bundles verified (base + acp-enhanced, no dsh-mnemon)"

# 3. User-layer patch: appended to the profile's template (init ships a
# comment-only cordis.patch.yml) only when it holds no entries yet — after
# that the file belongs to the user and re-runs never touch it.
USER_PATCH="${PROFILE_DIR}/cordis.patch.yml"
touch "${USER_PATCH}"
if grep -q '^- ' "${USER_PATCH}"; then
  echo "==> user-layer patch already present (left untouched)"
  for needle in subagent-model-selection-settings 'plugin-package-inventory-deepseek'; do
    if ! grep -q "${needle}" "${USER_PATCH}"; then
      echo "    note: '${needle}' is not in your patch layer; if this home boots a 0.1.2-alpha CLI, add it (see the bootstrap template in scripts/init-acp-home.sh)" >&2
    fi
  done
else
  # The profile template ships `[]` as its only effective content; strip that
  # line before appending real entries, or the file would hold a scalar array
  # followed by mappings (invalid YAML).
  perl -i -pe '$_ = "" if $_ =~ /^\[\]\s*$/ && !$done++' "${USER_PATCH}"

  # Machine-specific rows come from the old profile's user layer when it
  # exists — copied VERBATIM, because a gateway endpoint or a key env name is
  # local deployment data that must live only in $DSH_HOME, never in this
  # repo. Without an old profile, a commented web-search template is left to
  # fill in (README: web search section).
  OLD_USER_PATCH="${OLD_HOME}/profiles/acp-enhanced/cordis.patch.yml"
  if [ -f "${OLD_USER_PATCH}" ]; then
    cp "${OLD_USER_PATCH}" "${USER_PATCH}"
    perl -i -pe '$_ = "" if $_ =~ /^\[\]\s*$/ && !$done++' "${USER_PATCH}"
    echo "==> ported the old profile's user-layer patch verbatim"
  else
    cat >> "${USER_PATCH}" <<'PLACEHOLDER'
# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; `!!js` expressions allowed).
#
# Bootstrapped by scripts/init-acp-home.sh — edit freely, it is never
# overwritten by re-runs.

# Web search: the bridge ships no provider — mount any ctx.web provider you
# like here (user-layer insert rows for a plain package, or `dsh plugin add`
# for one declaring dsh.bundle) and point the web row at its provider id:
# - id: web
#   config:
#     searchProvider: <your-provider-id>
PLACEHOLDER
  fi

  # Machine-independent bootstrap rows, appended only when absent (a row
  # already present in ported content must not be duplicated — the loader
  # rejects duplicate entry ids at boot).
  if ! grep -q subagent-model-selection-settings "${USER_PATCH}"; then
    cat >> "${USER_PATCH}" <<'PATCH'

# 0.1.2-alpha harness presets mount tool-subagent with modelSelectionSettings
# enabled, which requires the subagentModelSelection settings service in the
# host scope. dsh-web-app provides it for the web profile; a dsh-base-only
# composition must mount it itself. (Pre-0.1.2-alpha harnesses do not export
# the module; keep this row only in homes booted by a 0.1.2-alpha CLI.)
- insert:
    - id: subagent-model-selection-settings
      name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings'
PATCH
  fi
  if ! grep -q plugin-package-inventory-deepseek "${USER_PATCH}"; then
    cat >> "${USER_PATCH}" <<'PATCH'

# Privacy: the 0.1.2-alpha dsh-base patch mounts the DeepSeek plugin-package
# inventory (enabled plugin names + versions reported to official DeepSeek
# requests) with enabled=true by default. Disable it unless you want it.
- id: plugin-package-inventory-deepseek
  config:
    enabled: false
PATCH
  fi
  echo "==> user-layer patch ready: ${USER_PATCH}"
fi

# 4. Credentials + settings from the default home (never overwritten).
for f in .credentials.yaml settings.yaml; do
  if [ -f "${OLD_HOME}/${f}" ] && [ ! -f "${NEW_HOME}/${f}" ]; then
    cp "${OLD_HOME}/${f}" "${NEW_HOME}/${f}"
    chmod 600 "${NEW_HOME}/${f}" 2>/dev/null || true
    echo "==> copied ${f} from the default home (mode 600)"
  fi
done

# 5. Agent-preset user root: share the default home's (symlink, not copy, so
# authored presets stay in one place).
if [ -d "${OLD_HOME}/.agent-presets" ] && [ ! -e "${NEW_HOME}/.agent-presets" ]; then
  ln -s "${OLD_HOME}/.agent-presets" "${NEW_HOME}/.agent-presets"
  echo "==> linked the agent-preset user root"
fi

# Home-layer patch from the default home, when present.
if [ -f "${OLD_HOME}/cordis.patch.yml" ] && [ ! -f "${NEW_HOME}/cordis.patch.yml" ]; then
  cp "${OLD_HOME}/cordis.patch.yml" "${NEW_HOME}/cordis.patch.yml"
  echo "==> ported the home-layer patch"
fi

# The bridge's per-model effort memory lives next to the profile's own files.
if [ -f "${OLD_HOME}/profiles/acp-enhanced/dsh-acp-enhanced-effort-memory.json" ] \
  && [ ! -f "${PROFILE_DIR}/dsh-acp-enhanced-effort-memory.json" ]; then
  cp "${OLD_HOME}/profiles/acp-enhanced/dsh-acp-enhanced-effort-memory.json" \
    "${PROFILE_DIR}/dsh-acp-enhanced-effort-memory.json"
  echo "==> migrated the effort memory"
fi

# Session history: both harness generations persist under
# $DSH_HOME/sessions/<cwd-slug>/<id>/session.jsonl.zstd, and the new
# generation reads old-generation logs (verified: history replay + preset fold
# work cross-generation). Nothing is copied by default — the default home's
# tree also holds every web-profile session and can be large. Opt in with
# --copy-sessions to rsync it (never overwriting what the new home already
# has), or run the printed command yourself later.
if [ "${1:-}" = "--copy-sessions" ]; then
  mkdir -p "${NEW_HOME}/sessions"
  rsync -a --ignore-existing "${OLD_HOME}/sessions/" "${NEW_HOME}/sessions/"
  echo "==> copied old-home session history (existing sessions kept)"
fi

echo
echo "Bootstrap complete. Next:"
echo "  - Zed: keep agent_servers pointing at ${REPO_DIR}/scripts/dsh-acp-zed.sh (it now resolves the repo-pinned CLI and exports DSH_HOME=${NEW_HOME} automatically)."
echo "  - Smoke test: DSH_HOME=${NEW_HOME} node scripts/acp-client.mjs scripts/dsh-acp-zed.sh"
echo "  - Optional, to make old Zed threads resumable on the new host: rsync -a --ignore-existing ${OLD_HOME}/sessions/ ${NEW_HOME}/sessions/"
echo "    (old-home sessions live on; both generations use \$DSH_HOME/sessions/<slug>/<id>/session.jsonl.zstd and the new host reads old logs)"
