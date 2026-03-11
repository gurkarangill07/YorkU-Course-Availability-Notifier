#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env.local"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing ${ENV_FILE}. Create it before running this command."
  exit 1
fi

if [[ "$#" -eq 0 ]]; then
  echo "Usage: scripts/with-env.sh <command> [args...]"
  exit 1
fi

# Preserve explicit env overrides passed to this script invocation.
__existing_keys=()
__existing_values=()
while IFS= read -r __line || [[ -n "${__line}" ]]; do
  [[ "${__line}" =~ ^[[:space:]]*$ ]] && continue
  [[ "${__line}" =~ ^[[:space:]]*# ]] && continue
  if [[ "${__line}" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)= ]]; then
    __key="${BASH_REMATCH[2]}"
    if [[ -n "${!__key+x}" ]]; then
      __existing_keys+=("${__key}")
      __existing_values+=("${!__key}")
    fi
  fi
done < "${ENV_FILE}"

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

for __idx in "${!__existing_keys[@]}"; do
  __key="${__existing_keys[${__idx}]}"
  export "${__key}=${__existing_values[${__idx}]}"
done

exec "$@"
