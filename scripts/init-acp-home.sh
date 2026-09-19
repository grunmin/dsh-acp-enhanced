#!/bin/bash
# OPTIONAL bootstrap for an isolated dsh home carrying the acp-enhanced
# profile (see docs/plans/2026-09-01-dsh-0.1.2-alpha.2-migration.md).
#
# The launcher (scripts/dsh-acp-zed.sh) does NOT switch homes. It boots the
# profile inside the dsh home it was started with (${DSH_HOME:-$HOME/.dsh}), so
# the ACP profile is normally just another profile in the default home, sharing
# credentials, settings, sessions and presets with `dsh web`. The usual way to
# create it is a single command:
#
#   dsh plugin --profile acp-enhanced add link:<this repo>
#
# This script remains for the isolated-home setup: it builds a self-contained
# home (default ~/.dsh-acp, override with DSH_ACP_HOME) whose
# $DSH_HOME/profiles/node_modules closure is not shared with the default home.
# To use that home you must point the launcher at it yourself — export
# DSH_HOME=<that home> (Zed: `agent_servers.env`); the launcher honors an
# inherited DSH_HOME verbatim.
#
# What it creates (re-running is safe: existing files are never clobbered):
#
#   1. profile 'acp-enhanced' via `dsh plugin add` (bundles:
#      @deepseek-ai/dsh-base + dsh-acp-enhanced — deliberately WITHOUT
#      dsh-mnemon, which does not support the 0.1.2-alpha harness)
#   2. bundle-set verification (the profile must never carry dsh-mnemon)
#   3. the user-layer cordis.patch.yml: your old profile's user rows ported
#      verbatim (web-search routing and friends — machine-specific values
#      never shipped with this repo), plus the DeepSeek plugin-inventory
#      reporter disabled; a legacy `subagent-model-selection-settings` row is
#      retired from this layer, because the bridge's bundle patch inserts that
#      host row itself and a duplicate id aborts the boot
#   4. credentials + settings from the default home (never overwritten)
#   5. the agent-preset user root, home-layer patch, and the bridge's effort
#      memory, when the default home has them
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

if [ "${NEW_HOME}" = "${OLD_HOME}" ]; then
  SAME_HOME=1
else
  SAME_HOME=0
fi

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

# 2b. The profile is a single failure domain: the loader rethrows the first
# rejected entry, so any extra bundle is a boot-wide risk. Report them instead
# of removing them — the operator may have accepted the trade deliberately.
EXTRA_BUNDLES="$(python3 -c "
import json
p = json.load(open('${PROFILE_DIR}/package.json'))
bundles = p.get('dsh', {}).get('profile', {}).get('bundles', [])
minimal = {'@deepseek-ai/dsh-base', 'dsh-acp-enhanced'}
print(','.join(sorted(set(bundles) - minimal)), end='')
")"
if [ -n "${EXTRA_BUNDLES}" ]; then
  echo "==> note: extra bundle(s) in this profile: ${EXTRA_BUNDLES}" >&2
  echo "    Every extra bundle sits on the boot path of every ACP thread; a single failing" >&2
  echo "    entry aborts the whole profile. Prefer a preset composition for plugins that" >&2
  echo "    only add model-facing tools, and re-run ${REPO_DIR}/scripts/acp-doctor.mjs after" >&2
  echo "    any change (README: 'Keep the profile minimal')." >&2
fi

# 3. User-layer patch: appended to the profile's template (init ships a
# comment-only cordis.patch.yml) only when it holds no entries yet — after
# that the file belongs to the user and re-runs never touch it.
USER_PATCH="${PROFILE_DIR}/cordis.patch.yml"
touch "${USER_PATCH}"
if grep -q '^- ' "${USER_PATCH}"; then
  echo "==> user-layer patch already present"
  if ! grep -q plugin-package-inventory-deepseek "${USER_PATCH}"; then
    echo "    note: 'plugin-package-inventory-deepseek' is not in your patch layer (optional:" >&2
    echo "    it disables the plugin-inventory report to official DeepSeek requests)" >&2
  fi
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
  if [ "${SAME_HOME}" = 0 ] && [ -f "${OLD_USER_PATCH}" ]; then
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
  #
  # `subagent-model-selection-settings` is deliberately NOT seeded here: the
  # bridge's own bundle patch inserts it (the same row @deepseek-ai/dsh-web-app
  # inserts for the web profile), and a copy in this layer would collide with it
  # (`duplicate loader entry id` aborts the whole plugin tree). Legacy copies are
  # retired by the migration below.
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

# 3b. Migration: retire a legacy user-layer copy of
# `subagent-model-selection-settings`. The bridge's bundle patch inserts that
# host row itself now (the row @deepseek-ai/dsh-web-app inserts for the web
# profile), and a second copy — which older revisions of this script wrote into
# this very file — makes the loader abort with `duplicate loader entry id`,
# killing every ACP thread. The row is only removed from the user layer, and
# only when the installed bundle patch actually provides it; a timestamped
# backup is left next to the file.
BUNDLE_PATCH="${PROFILE_DIR}/node_modules/dsh-acp-enhanced/cordis.patch.yml"
ROW_RE='^[[:space:]]*- id:[[:space:]]*subagent-model-selection-settings[[:space:]]*$'
if [ -f "${BUNDLE_PATCH}" ] \
  && grep -q 'subagent-model-selection-settings' "${BUNDLE_PATCH}" \
  && grep -qE "${ROW_RE}" "${USER_PATCH}"; then
  cp "${USER_PATCH}" "${USER_PATCH}.bak-$(date +%Y%m%d-%H%M%S)"
  python3 - "${USER_PATCH}" <<'RETIRE'
import re, sys
path = sys.argv[1]
lines = open(path).read().split('\n')
row = re.compile(r'^([ \t]*)- id:[ \t]*subagent-model-selection-settings[ \t]*$')
insert = re.compile(r'^([ \t]*)- insert:[ \t]*$')

# pass 1: drop the row (and its deeper-indented body)
kept, i = [], 0
while i < len(lines):
    match = row.match(lines[i])
    if match is None:
        kept.append(lines[i]); i += 1; continue
    indent = len(match.group(1))
    i += 1
    while i < len(lines):
        line = lines[i]
        if line.strip() == '':
            nxt = lines[i + 1] if i + 1 < len(lines) else ''
            if (len(nxt) - len(nxt.lstrip())) > indent:
                i += 1; continue
            break
        if (len(line) - len(line.lstrip())) <= indent:
            break
        i += 1

# pass 2: drop `- insert:` blocks with no rows left in them
final, j = [], 0
while j < len(kept):
    match = insert.match(kept[j])
    if match is None:
        final.append(kept[j]); j += 1; continue
    indent = len(match.group(1)); k = j + 1; body = []
    while k < len(kept):
        line = kept[k]
        if line.strip() == '':
            body.append(line); k += 1; continue
        if (len(line) - len(line.lstrip())) <= indent:
            break
        body.append(line); k += 1
    if any(re.match(r'^[ \t]*- ', line) for line in body):
        final.append(kept[j]); final.extend(body)
    j = k

text = re.sub(r'\n{3,}', '\n\n', '\n'.join(final))
# A patch layer with no entries must stay the `[]` the profile template ships:
# a comment-only (empty) document is not a loader patch list.
if not re.search(r'^[ \t]*- ', text, flags=re.M):
    text = text.rstrip('\n') + '\n[]\n' if not re.search(r'^\[\][ \t]*$', text, flags=re.M) else text
open(path, 'w').write(text)
RETIRE
  echo "==> retired the legacy user-layer 'subagent-model-selection-settings' row"
  echo "    (the bundle patch provides it; backup: ${USER_PATCH}.bak-*)"
fi

# 4. Credentials + settings + authored state, migrated from the default home
# (never overwritten). Skipped when the target IS the default home: there is
# nothing to migrate and a self-symlink would be wrong.
if [ "${SAME_HOME}" = 1 ]; then
  echo "==> target home is the default home; no migration needed"
else
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
echo "  - This is an ISOLATED home: the launcher never moves to it by itself."
echo "    Point the launcher at it by exporting DSH_HOME=${NEW_HOME}"
echo "    (Zed: agent_servers.env), and keep agent_servers running"
echo "    ${REPO_DIR}/scripts/dsh-acp-zed.sh"
echo "  - For the shared default home instead, skip this script and run:"
echo "      dsh plugin --profile acp-enhanced add link:${REPO_DIR}"
echo "  - Smoke test: DSH_HOME=${NEW_HOME} node scripts/acp-client.mjs scripts/dsh-acp-zed.sh"
echo "  - Optional, to make old Zed threads resumable on the new host: rsync -a --ignore-existing ${OLD_HOME}/sessions/ ${NEW_HOME}/sessions/"
echo "    (old-home sessions live on; both generations use \$DSH_HOME/sessions/<slug>/<id>/session.jsonl.zstd and the new host reads old logs)"
