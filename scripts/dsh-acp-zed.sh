#!/bin/bash
# Zed launcher for dsh-acp-enhanced.
#
# The profile resolves DEEPSEEK_API_KEY through the dsh credentials service
# (~/.dsh/.credentials.yaml), so no environment plumbing is required. This
# wrapper only:
#   1. prefers an explicit DEEPSEEK_API_KEY from Zed's agent_servers.env, and
#   2. falls back to the key of a running `dsh web` process (ps eww) for
#      setups that keep the key in the web launch environment instead.
# stdout stays the ACP JSON-RPC wire; diagnostics go to stderr.
set -u

if [ -z "${DEEPSEEK_API_KEY:-}" ]; then
  WEB_PID="$(pgrep -f 'dsh web' | head -n 1)"
  if [ -n "${WEB_PID}" ]; then
    KEY="$(ps eww "${WEB_PID}" 2>/dev/null | tr ' ' '\n' | grep '^DEEPSEEK_API_KEY=' | cut -d= -f2-)"
    if [ -n "${KEY}" ]; then
      export DEEPSEEK_API_KEY="${KEY}"
    fi
  fi
fi

exec dsh --profile acp-enhanced "$@"
