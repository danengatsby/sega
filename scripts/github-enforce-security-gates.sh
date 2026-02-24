#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  echo "Missing GITHUB_TOKEN. Export a GitHub token with repo admin permissions."
  exit 1
fi

REPO_SLUG="${1:-${GITHUB_REPOSITORY:-}}"
if [[ -z "${REPO_SLUG}" ]]; then
  echo "Usage: GITHUB_TOKEN=... $0 <owner/repo>"
  echo "Or set GITHUB_REPOSITORY=<owner/repo>."
  exit 1
fi

if [[ "${REPO_SLUG}" != */* ]]; then
  echo "Invalid repository slug '${REPO_SLUG}'. Expected format: owner/repo"
  exit 1
fi

PREFERRED_REQUIRED_CONTEXTS=(
  "ANAF Smoke"
  "Security Gates"
  "OpenAPI Contract"
  "Performance KPI"
  "Frontend Tests"
  "Observability Config"
  "Release Checklist"
)
REQUIRED_CONTEXTS_JSON="${REQUIRED_CONTEXTS_JSON:-}"
BRANCHES=("main" "master")

api_url() {
  local path="$1"
  printf "https://api.github.com%s" "${path}"
}

fetch_workflow_names() {
  local response_file="/tmp/sega-workflows.json"
  local code
  code="$(
    curl -sS -o "${response_file}" -w '%{http_code}' \
      -H "Authorization: Bearer ${GITHUB_TOKEN}" \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      "$(api_url "/repos/${REPO_SLUG}/actions/workflows?per_page=100")"
  )"

  if [[ "${code}" != "200" ]]; then
    echo "Failed to list workflows (HTTP ${code})."
    cat "${response_file}" || true
    exit 1
  fi

  jq -r '.workflows[].name' "${response_file}"
}

if [[ -z "${REQUIRED_CONTEXTS_JSON}" ]]; then
  mapfile -t available_workflows < <(fetch_workflow_names)
  declare -A available_set=()
  for name in "${available_workflows[@]}"; do
    available_set["${name}"]=1
  done

  selected_contexts=()
  missing_contexts=()
  for context in "${PREFERRED_REQUIRED_CONTEXTS[@]}"; do
    if [[ -n "${available_set[${context}]:-}" ]]; then
      selected_contexts+=("${context}")
    else
      missing_contexts+=("${context}")
    fi
  done

  if [[ ${#selected_contexts[@]} -eq 0 ]]; then
    echo "No preferred required checks are available in repository workflows."
    echo "Preferred list: ${PREFERRED_REQUIRED_CONTEXTS[*]}"
    exit 1
  fi

  REQUIRED_CONTEXTS_JSON="$(
    printf '%s\n' "${selected_contexts[@]}" | jq -R . | jq -s .
  )"

  if [[ ${#missing_contexts[@]} -gt 0 ]]; then
    echo "Skipping unavailable checks: ${missing_contexts[*]}"
  fi
fi

branch_exists() {
  local branch="$1"
  local code
  code="$(
    curl -sS -o /tmp/sega-branch-check.json -w '%{http_code}' \
      -H "Authorization: Bearer ${GITHUB_TOKEN}" \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      "$(api_url "/repos/${REPO_SLUG}/branches/${branch}")"
  )"

  if [[ "${code}" == "200" ]]; then
    return 0
  fi

  if [[ "${code}" == "404" ]]; then
    return 1
  fi

  # GitHub may return 301 when the branch was renamed (e.g. master -> main).
  if [[ "${code}" == "301" ]]; then
    return 1
  fi

  echo "Failed to inspect branch '${branch}' (HTTP ${code})."
  cat /tmp/sega-branch-check.json || true
  exit 1
}

apply_protection() {
  local branch="$1"
  local payload

  payload="$(
    jq -cn \
      --argjson contexts "${REQUIRED_CONTEXTS_JSON}" \
      '{
        required_status_checks: {
          strict: true,
          contexts: $contexts
        },
        enforce_admins: true,
        required_pull_request_reviews: null,
        restrictions: null,
        required_linear_history: false,
        allow_force_pushes: false,
        allow_deletions: false,
        block_creations: false,
        required_conversation_resolution: false,
        lock_branch: false,
        allow_fork_syncing: false
      }'
  )"

  local response_file="/tmp/sega-protection-${branch}.json"
  local code
  code="$(
    curl -sS -o "${response_file}" -w '%{http_code}' \
      -X PUT \
      -H "Authorization: Bearer ${GITHUB_TOKEN}" \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      -d "${payload}" \
      "$(api_url "/repos/${REPO_SLUG}/branches/${branch}/protection")"
  )"

  if [[ "${code}" != "200" ]]; then
    echo "Failed to protect branch '${branch}' (HTTP ${code})."
    cat "${response_file}" || true
    exit 1
  fi

  local contexts_print
  contexts_print="$(echo "${REQUIRED_CONTEXTS_JSON}" | jq -r 'join(", ")')"
  echo "Protected branch '${branch}' with required checks: ${contexts_print}"
}

echo "Applying branch protection on ${REPO_SLUG}..."
for branch in "${BRANCHES[@]}"; do
  if branch_exists "${branch}"; then
    apply_protection "${branch}"
  else
    echo "Skipping '${branch}' (branch not found)."
  fi
done

echo "Done."
