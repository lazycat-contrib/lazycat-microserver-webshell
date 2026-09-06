#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "${script_dir}/.." && pwd)"
runner="${script_dir}/run-playwright.mjs"
default_ios_user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"

# Load repository-local dotenv defaults without overwriting variables supplied
# explicitly by the caller, so CI and one-off runs can still override them.
dotenv_file="${script_dir}/.env"
if [[ -f "${dotenv_file}" ]]; then
  while IFS= read -r dotenv_line || [[ -n "${dotenv_line}" ]]; do
    dotenv_line="${dotenv_line#${dotenv_line%%[![:space:]]*}}"
    [[ -z "${dotenv_line}" || "${dotenv_line:0:1}" == "#" || "${dotenv_line}" != *=* ]] && continue
    dotenv_key="${dotenv_line%%=*}"
    dotenv_value="${dotenv_line#*=}"
    [[ "${dotenv_key}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    dotenv_value="${dotenv_value%${dotenv_value##*[![:space:]]}}"
    if [[ "${dotenv_value}" == \"*\" && "${dotenv_value}" == *\" ]]; then
      dotenv_value="${dotenv_value:1:${#dotenv_value}-2}"
    elif [[ "${dotenv_value}" == \'*\' && "${dotenv_value}" == *\' ]]; then
      dotenv_value="${dotenv_value:1:${#dotenv_value}-2}"
    fi
    if [[ -z "${!dotenv_key+x}" ]]; then
      export "${dotenv_key}=${dotenv_value}"
    fi
  done < "${dotenv_file}"
fi

mapfile -t cases < <(find "${script_dir}" -mindepth 2 -maxdepth 2 -type f -name test.mjs -printf '%h\n' | sort)
if (( ${#cases[@]} == 0 )); then
  echo "tests-auto: no test cases found" >&2
  exit 1
fi

default_static_dir="${WEBSHELL_LOCAL_STATIC_DIR:-${repo_dir}/build/runtime/static}"
if [[ "${TESTS_AUTO_DRY_RUN:-0}" != "1" && "${TESTS_AUTO_SKIP_BUILD:-0}" != "1" ]]; then
  (cd "${repo_dir}" && npm run build)
fi

for case_dir in "${cases[@]}"; do
  case_name="$(basename -- "${case_dir}")"
  case_static_dir="${default_static_dir}"
  case_mobile_user_agent="${WEBSHELL_MOBILE_USER_AGENT:-}"
  if [[ "${case_name}" == "04-terminal-viewport" && -z "${case_mobile_user_agent}" ]]; then
    case_mobile_user_agent="${default_ios_user_agent}"
  fi
  if [[ "${case_name}" == "11-service-worker-retirement" ]]; then
    case_static_dir=""
  fi
  if [[ "${TESTS_AUTO_DRY_RUN:-0}" == "1" ]]; then
    printf '[tests-auto] PROFILE %s static=%s mobile_ua=%s\n' \
      "${case_name}" \
      "${case_static_dir:-<empty>}" \
      "${case_mobile_user_agent:-<default>}"
    continue
  fi
  echo "[tests-auto] START ${case_name}"
  case_log="$(mktemp)"
  if ! WEBSHELL_LOCAL_STATIC_DIR="${case_static_dir}" \
    WEBSHELL_MOBILE_USER_AGENT="${case_mobile_user_agent}" \
    node "${runner}" "${case_dir}/test.mjs" 2>&1 | tee "${case_log}"; then
    rm -f -- "${case_log}"
    exit 1
  fi
  if grep -Eq '\[skip\]|-skipped' "${case_log}"; then
    echo "[tests-auto] FAIL  ${case_name}: required scenario reported a skip" >&2
    rm -f -- "${case_log}"
    exit 1
  fi
  rm -f -- "${case_log}"
  echo "[tests-auto] PASS  ${case_name}"
done

if [[ "${TESTS_AUTO_DRY_RUN:-0}" == "1" ]]; then
  echo "[tests-auto] ${#cases[@]} case profile(s) ready"
  exit 0
fi

echo "[tests-auto] all ${#cases[@]} case(s) passed"
