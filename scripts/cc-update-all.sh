#!/usr/bin/env bash
# =============================================================================
# cc-update-all (plugin version) — Update all installed plugin marketplaces
#
# Discovers marketplaces from ~/.claude/plugins/installed_plugins.json and
# ~/.claude/plugins/known_marketplaces.json, then updates only those that have
# at least one installed plugin.
#
# Usage: cc-update-all.sh [flags]
#   --dry-run       Show what would change without executing
#   --only NAME     Update only the named marketplace
#   --json          Output summary as JSON
#   --force         Proceed even with dirty git repos
#   --check         Report outdated marketplaces without updating (exit 1 if any)
#   --help          Show this help message
#
# Compatible with bash 3.2+ (macOS default) — no associative arrays used.
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Temp directory for accumulating results (avoids associative arrays for
# bash 3.2 / macOS compatibility)
# ---------------------------------------------------------------------------
SUMMARY_DIR=$(mktemp -d "${TMPDIR:-/tmp}/cc-update-all.XXXXXX")
trap 'rm -rf "$SUMMARY_DIR"' EXIT

# Touch the result files
: > "${SUMMARY_DIR}/partial_failure"

# ---------------------------------------------------------------------------
# Color support — disabled when piped or in --json mode
# ---------------------------------------------------------------------------
_color_enabled() {
  [[ -t 1 ]] && [[ "${_JSON_MODE:-0}" -eq 0 ]] && return 0
  return 1
}

_COLOR_BOLD="" _COLOR_GREEN="" _COLOR_YELLOW="" _COLOR_RED="" _COLOR_DIM="" _COLOR_RESET=""
if _color_enabled; then
  _COLOR_BOLD='\033[1m'
  _COLOR_GREEN='\033[0;32m'
  _COLOR_YELLOW='\033[0;33m'
  _COLOR_RED='\033[0;31m'
  _COLOR_DIM='\033[2m'
  _COLOR_RESET='\033[0m'
fi

# ---------------------------------------------------------------------------
# Defaults (use underscore prefix to avoid polluting namespace)
# ---------------------------------------------------------------------------
_DRY_RUN=0
_ONLY_MARKETPLACE=""
_JSON_MODE=0
_FORCE=0
_CHECK_MODE=0

_PLUGINS_DIR="${HOME}/.claude/plugins"
_INSTALLED_PLUGINS_FILE="${_PLUGINS_DIR}/installed_plugins.json"
_KNOWN_MARKETPLACES_FILE="${_PLUGINS_DIR}/known_marketplaces.json"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
info()  { printf "${_COLOR_BOLD}%s${_COLOR_RESET}\n" "$*"; }
ok()    { printf "${_COLOR_GREEN}%s${_COLOR_RESET}\n" "$*"; }
warn()  { printf "${_COLOR_YELLOW}%s${_COLOR_RESET}\n" "$*"; }
err()   { printf "${_COLOR_RED}%s${_COLOR_RESET}\n" "$*" >&2; }
dim()   { printf "${_COLOR_DIM}%s${_COLOR_RESET}\n" "$*"; }

has_jq() { command -v jq &>/dev/null; }

# Result accumulator — stores per-marketplace results as tab-separated files:
#   ${SUMMARY_DIR}/mp_<name>  = status<TAB>before<TAB>after<TAB>plugins
record_mp_result() {
  local name="$1" status="$2" before="$3" after="$4" plugins="$5"
  # Sanitize name for filename
  local safe_name
  safe_name=$(printf '%s' "$name" | tr -c 'a-zA-Z0-9_-' '_')
  printf '%s\t%s\t%s\t%s\n' "$status" "$before" "$after" "$plugins" > "${SUMMARY_DIR}/mp_${safe_name}"
  # Keep a list of marketplace names in order
  echo "$name" >> "${SUMMARY_DIR}/mp_names"
}

get_mp_results_sorted() {
  sort -u "${SUMMARY_DIR}/mp_names" 2>/dev/null || true
}

get_mp_field() {
  # $1=name $2=field_index (0=status, 1=before, 2=after, 3=plugins)
  local name="$1" idx="$2"
  local safe_name
  safe_name=$(printf '%s' "$name" | tr -c 'a-zA-Z0-9_-' '_')
  local line
  line=$(cat "${SUMMARY_DIR}/mp_${safe_name}" 2>/dev/null) || return 1
  echo "$line" | cut -f$((idx + 1))
}

mark_partial_failure() {
  echo "1" > "${SUMMARY_DIR}/partial_failure"
}

check_partial_failure() {
  [[ -f "${SUMMARY_DIR}/partial_failure" ]] && [[ "$(cat "${SUMMARY_DIR}/partial_failure")" == "1" ]]
}

# ---------------------------------------------------------------------------
# Parse CLI flags
# ---------------------------------------------------------------------------
parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dry-run)     _DRY_RUN=1 ;;
      --only)
        shift
        if [[ $# -eq 0 || -z "${1:-}" ]]; then
          err "--only requires a marketplace name"
          exit 2
        fi
        _ONLY_MARKETPLACE="$1"
        ;;
      --json)        _JSON_MODE=1 ;;
      --force)       _FORCE=1 ;;
      --check)       _CHECK_MODE=1 ;;
      --help|-h)
        awk 'NR==1{next} /^# ===/{if(n>0){exit} n++;next} /^#/{sub(/^# ?/,"");print}' "$0"
        exit 0
        ;;
      *)
        err "Unknown flag: $1"
        echo "Use --help for usage information." >&2
        exit 2
        ;;
    esac
    shift
  done
}

# ---------------------------------------------------------------------------
# JSON fallback parsers (when jq is unavailable)
# ---------------------------------------------------------------------------

# Extract unique marketplace names from plugin keys in installed_plugins.json.
# Plugin key format: "pluginName@marketplaceName"
extract_marketplaces_nojq() {
  local file="$1"
  grep -oE '"[^"]+@[^"]+"' "$file" 2>/dev/null \
    | sed -E 's/.*"([^"]+)@([^"]+)".*/\2/' \
    | sort -u
}

# Extract plugin names for a given marketplace from plugin keys.
extract_plugins_for_marketplace_nojq() {
  local file="$1"
  local marketplace="$2"
  grep -oE "\"[^\"]+@${marketplace}\"" "$file" 2>/dev/null \
    | sed -E 's/"([^"]+)@.*/\1/' \
    | sort
}

# Get the source type for a marketplace from known_marketplaces.json.
get_marketplace_source_type_nojq() {
  local file="$1"
  local name="$2"
  sed -n "/\"${name}\"/,/}/p" "$file" 2>/dev/null \
    | grep -oE '"source"\s*:\s*"[^"]+"' \
    | head -1 \
    | sed -E 's/.*"source"\s*:\s*"([^"]+)".*/\1/'
}

# Get the installLocation for a marketplace.
get_marketplace_install_location_nojq() {
  local file="$1"
  local name="$2"
  sed -n "/\"${name}\"/,/}/p" "$file" 2>/dev/null \
    | grep -oE '"installLocation"\s*:\s*"[^"]+"' \
    | head -1 \
    | sed -E 's/.*"installLocation"\s*:\s*"([^"]+)".*/\1/'
}

# Get the repo for a github-sourced marketplace.
get_marketplace_repo_nojq() {
  local file="$1"
  local name="$2"
  sed -n "/\"${name}\"/,/}/p" "$file" 2>/dev/null \
    | grep -oE '"repo"\s*:\s*"[^"]+"' \
    | head -1 \
    | sed -E 's/.*"repo"\s*:\s*"([^"]+)".*/\1/'
}

# ---------------------------------------------------------------------------
# Data readers (with jq or fallback)
# ---------------------------------------------------------------------------

read_installed_marketplaces() {
  local file="$1"
  if ! [[ -f "$file" ]]; then
    return 1
  fi

  if has_jq; then
    jq -r '.plugins | keys[]' "$file" 2>/dev/null \
      | sed -E 's/.*@(.*)/\1/' \
      | sort -u
  else
    extract_marketplaces_nojq "$file"
  fi
}

read_plugins_for_marketplace() {
  local file="$1"
  local marketplace="$2"

  if has_jq; then
    jq -r --arg mp "$marketplace" \
      '.plugins | to_entries[] | select(.key | endswith("@" + $mp)) | .key | split("@")[0]' \
      "$file" 2>/dev/null
  else
    extract_plugins_for_marketplace_nojq "$file" "$marketplace"
  fi
}

read_marketplace_source_type() {
  local file="$1"
  local name="$2"

  if has_jq; then
    jq -r --arg n "$name" '.[$n].source.source // empty' "$file" 2>/dev/null
  else
    get_marketplace_source_type_nojq "$file" "$name"
  fi
}

read_marketplace_install_location() {
  local file="$1"
  local name="$2"

  if has_jq; then
    jq -r --arg n "$name" '.[$n].installLocation // empty' "$file" 2>/dev/null
  else
    get_marketplace_install_location_nojq "$file" "$name"
  fi
}

read_marketplace_repo() {
  local file="$1"
  local name="$2"

  if has_jq; then
    jq -r --arg n "$name" '.[$n].source.repo // empty' "$file" 2>/dev/null
  else
    get_marketplace_repo_nojq "$file" "$name"
  fi
}

# ---------------------------------------------------------------------------
# Marketplace update
# ---------------------------------------------------------------------------
update_marketplace() {
  local name="$1"
  local source_type="$2"
  local install_dir="$3"
  local repo="$4"
  local plugins="$5"

  # Check install location exists
  if [[ ! -d "$install_dir" ]]; then
    record_mp_result "$name" "not_found" "-" "-" "$plugins"
    warn "  [SKIPPED] ${name}  install location not found: ${install_dir}"
    mark_partial_failure
    return 0
  fi

  # Handle non-git marketplaces
  if [[ "$source_type" == "directory" ]]; then
    record_mp_result "$name" "local_directory" "-" "-" "$plugins"
    dim "  [SKIPPED] ${name}  local directory (manual)"
    return 0
  fi

  # Check if it's a git repo
  if [[ ! -d "${install_dir}/.git" ]]; then
    record_mp_result "$name" "not_git" "-" "-" "$plugins"
    warn "  [SKIPPED] ${name}  not a git repo"
    return 0
  fi

  # Check for dirty working tree
  if [[ "$_FORCE" -ne 1 ]]; then
    if [[ -n $(git -C "$install_dir" status --porcelain 2>/dev/null) ]]; then
      record_mp_result "$name" "dirty" "-" "-" "$plugins"
      warn "  [SKIPPED] ${name}  has local changes (use --force to override)"
      return 0
    fi
  fi

  # Detect current branch and upstream remote
  local branch
  branch="$(git -C "$install_dir" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")"

  local upstream
  upstream="$(git -C "$install_dir" rev-parse --abbrev-ref "@{upstream}" 2>/dev/null || true)"

  if [[ -z "$upstream" ]]; then
    record_mp_result "$name" "no_upstream" "$before_sha" "$before_sha" "$plugins"
    warn "  [SKIPPED] ${name}  no upstream branch configured"
    return 0
  fi

  local remote branch_name
  remote="${upstream%%/*}"
  branch_name="${upstream#*/}"

  # Get before SHA
  local before_sha
  before_sha="$(git -C "$install_dir" rev-parse --short HEAD 2>/dev/null || echo "unknown")"

  if [[ "$_DRY_RUN" -eq 1 ]]; then
    record_mp_result "$name" "dry_run" "$before_sha" "${before_sha} (would update)" "$plugins"
    dim "  [DRY RUN] ${name}  would git pull ${repo} (${branch})"
    return 0
  fi

  # Fetch
  if ! git -C "$install_dir" fetch --all --prune 2>/dev/null; then
    record_mp_result "$name" "fetch_failed" "$before_sha" "$before_sha" "$plugins"
    err "  [FAILED] ${name}  git fetch failed"
    dim "  Rollback: git -C \"${install_dir}\" reset --hard ${before_sha}"
    mark_partial_failure
    return 0
  fi

  # Try fast-forward pull
  if git -C "$install_dir" pull --ff-only "$remote" "$branch_name" 2>&1; then
    local after_sha
    after_sha="$(git -C "$install_dir" rev-parse --short HEAD 2>/dev/null || echo "$before_sha")"

    if [[ "$before_sha" == "$after_sha" ]]; then
      record_mp_result "$name" "up_to_date" "$before_sha" "$after_sha" "$plugins"
      dim "  [SKIPPED] ${name}  already up to date"
    else
      record_mp_result "$name" "updated" "$before_sha" "$after_sha" "$plugins"
      ok "  [UPDATED] ${name}  ${before_sha} -> ${after_sha}"
    fi
  else
    # ff-only failed — likely diverged
    record_mp_result "$name" "diverged" "$before_sha" "$before_sha" "$plugins"
    warn "  [SKIPPED] ${name}  cannot fast-forward (branch may have diverged)"
    dim "  Rollback: git -C \"${install_dir}\" reset --hard ${before_sha}"
    mark_partial_failure
  fi
}

# ---------------------------------------------------------------------------
# Summary output (text mode)
# ---------------------------------------------------------------------------
print_summary_text() {
  echo ""
  info "========== SUMMARY =========="

  # Count and display marketplaces
  local mp_count=0
  local sorted_names
  sorted_names=$(get_mp_results_sorted)
  if [[ -z "$sorted_names" ]]; then
    dim "No plugin marketplaces with installed plugins found."
    return 0
  fi

  info "Marketplaces (with installed plugins):"

  while IFS= read -r name; do
    [[ -z "$name" ]] && continue
    mp_count=$((mp_count + 1))

    local status before after
    status=$(get_mp_field "$name" 0)
    before=$(get_mp_field "$name" 1)
    after=$(get_mp_field "$name" 2)

    case "$status" in
      updated)
        ok "  [UPDATED]  ${name}  ${before} -> ${after}"
        ;;
      up_to_date)
        dim "  [SKIPPED]  ${name}  already up to date"
        ;;
      local_directory)
        dim "  [SKIPPED]  ${name}  local directory (manual)"
        ;;
      not_git)
        warn "  [SKIPPED]  ${name}  not a git repo"
        ;;
      dirty)
        warn "  [SKIPPED]  ${name}  has local changes"
        ;;
      not_found)
        warn "  [SKIPPED]  ${name}  install location not found"
        ;;
      fetch_failed)
        err "  [FAILED]  ${name}  git fetch failed"
        ;;
      diverged)
        warn "  [SKIPPED]  ${name}  cannot fast-forward"
        ;;
      no_upstream)
        warn "  [SKIPPED]  ${name}  no upstream branch configured"
        ;;
      dry_run)
        dim "  [DRY RUN]  ${name}  ${before}"
        ;;
      *)
        dim "  [UNKNOWN]  ${name}  ${status}"
        ;;
    esac
  done <<< "$sorted_names"

  echo ""
  dim "Tip: Restart Claude Code to pick up plugin changes."
}

# ---------------------------------------------------------------------------
# Summary output (JSON mode)
# ---------------------------------------------------------------------------
print_summary_json() {
  local sorted_names
  sorted_names=$(get_mp_results_sorted)

  if [[ -z "$sorted_names" ]] && has_jq; then
    echo '{"marketplaces":[]}'
    return 0
  elif [[ -z "$sorted_names" ]]; then
    printf '{\n  "marketplaces": []\n}\n'
    return 0
  fi

  if has_jq; then
    # Safe JSON via jq — proper string escaping
    {
      while IFS= read -r name; do
        [[ -z "$name" ]] && continue
        local status before after plugins_raw
        status=$(get_mp_field "$name" 0)
        before=$(get_mp_field "$name" 1)
        after=$(get_mp_field "$name" 2)
        plugins_raw=$(get_mp_field "$name" 3)

        # Output tab-separated: name, status, before, after, plugins_csv
        printf '%s\t%s\t%s\t%s\t%s\n' "$name" "$status" "$before" "$after" "$plugins_raw"
      done <<< "$sorted_names"
    } | jq -nR '
      [inputs | split("\t") |
        {
          name: .[0],
          status: (if .[1] == "fetch_failed" then "failed" else .[1] end),
          before: .[2],
          after: .[3],
          installed_plugins: (
            if .[4] == "" then []
            else .[4] | split(",")
            end
          )
        }
      ] | {"marketplaces": .}'
  else
    # Best-effort fallback (no jq) — manual JSON, may break on unusual names
    local marketplaces_json=""
    local first=true

    while IFS= read -r name; do
      [[ -z "$name" ]] && continue

      local status before after plugins_raw
      status=$(get_mp_field "$name" 0)
      before=$(get_mp_field "$name" 1)
      after=$(get_mp_field "$name" 2)
      plugins_raw=$(get_mp_field "$name" 3)

      local plugins_json="[]"
      if [[ -n "$plugins_raw" ]]; then
        local p_first=true
        plugins_json="["
        local IFS_SAVE="$IFS"
        IFS=','
        for plugin in $plugins_raw; do
          [[ -z "$plugin" ]] && continue
          if [[ "$p_first" == "true" ]]; then
            p_first=false
          else
            plugins_json+=", "
          fi
          plugins_json+="\"${plugin}\""
        done
        IFS="$IFS_SAVE"
        plugins_json+="]"
      fi

      local comma=""
      if [[ "$first" == "true" ]]; then
        first=false
      else
        comma=","
      fi

      local output_status="$status"
      case "$status" in
        dry_run)       output_status="dry_run" ;;
        fetch_failed)  output_status="failed" ;;
        *)             output_status="$status" ;;
      esac

      marketplaces_json+="${comma}
    {
      \"name\": \"${name}\",
      \"status\": \"${output_status}\",
      \"before\": \"${before}\",
      \"after\": \"${after}\",
      \"installed_plugins\": ${plugins_json}
    }"
    done <<< "$sorted_names"

    printf '{\n  "marketplaces": [%s\n  ]\n}\n' "$marketplaces_json"
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  parse_args "$@"

  # Check for required files
  if [[ ! -f "$_INSTALLED_PLUGINS_FILE" ]]; then
    err "No installed plugins found at ${_INSTALLED_PLUGINS_FILE}"
    err "Have you installed any Claude Code plugins?"
    exit 2
  fi

  if [[ ! -f "$_KNOWN_MARKETPLACES_FILE" ]]; then
    err "No known marketplaces found at ${_KNOWN_MARKETPLACES_FILE}"
    err "Have you configured any Claude Code plugin marketplaces?"
    exit 2
  fi

  # Step 1: Read installed plugins and extract unique marketplace names
  local marketplace_names=()
  while IFS= read -r mp_name; do
    [[ -z "$mp_name" ]] && continue
    marketplace_names+=("$mp_name")
  done < <(read_installed_marketplaces "$_INSTALLED_PLUGINS_FILE")

  if [[ ${#marketplace_names[@]} -eq 0 ]]; then
    warn "No installed plugins found. Nothing to update."
    if [[ "$_JSON_MODE" -eq 1 ]]; then
      print_summary_json
    else
      print_summary_text
    fi
    exit 0
  fi

  # Step 2: Filter by --only if specified
  if [[ -n "$_ONLY_MARKETPLACE" ]]; then
    local found=false
    local filtered=()
    for mp in "${marketplace_names[@]}"; do
      if [[ "$mp" == "$_ONLY_MARKETPLACE" ]]; then
        filtered+=("$mp")
        found=true
      fi
    done
    if [[ "$found" == "false" ]]; then
      err "Marketplace '${_ONLY_MARKETPLACE}' not found among installed plugins."
      err "Available: ${marketplace_names[*]}"
      exit 1
    fi
    marketplace_names=("${filtered[@]}")
  fi

  # Step 2.5: --check mode — report outdated without updating
  if [[ "$_CHECK_MODE" -eq 1 ]]; then
    local has_outdated=false
    for mp_name in "${marketplace_names[@]}"; do
      local source_type install_dir repo
      source_type=$(read_marketplace_source_type "$_KNOWN_MARKETPLACES_FILE" "$mp_name" || true)
      install_dir=$(read_marketplace_install_location "$_KNOWN_MARKETPLACES_FILE" "$mp_name" || true)

      if [[ "$source_type" != "github" ]] || [[ ! -d "${install_dir}/.git" ]]; then
        continue
      fi

      git -C "$install_dir" fetch --all --prune 2>/dev/null || true

      local local_sha remote_sha
      local_sha="$(git -C "$install_dir" rev-parse HEAD 2>/dev/null || echo "")"
      remote_sha="$(git -C "$install_dir" rev-parse "@{upstream}" 2>/dev/null || echo "")"

      if [[ -n "$local_sha" ]] && [[ -n "$remote_sha" ]] && [[ "$local_sha" != "$remote_sha" ]]; then
        has_outdated=true
        ok "  [OUTDATED] ${mp_name}"
      fi
    done

    if [[ "$has_outdated" == "true" ]]; then
      exit 1
    fi
    dim "All marketplaces are up to date."
    exit 0
  fi

  # Step 3: Update each marketplace
  info "Updating plugin marketplaces..."
  echo ""

  for mp_name in "${marketplace_names[@]}"; do
    # Get marketplace details from known_marketplaces.json
    local source_type install_dir repo

    source_type=$(read_marketplace_source_type "$_KNOWN_MARKETPLACES_FILE" "$mp_name" || true)
    install_dir=$(read_marketplace_install_location "$_KNOWN_MARKETPLACES_FILE" "$mp_name" || true)
    repo=$(read_marketplace_repo "$_KNOWN_MARKETPLACES_FILE" "$mp_name" || true)

    # Get list of installed plugins for this marketplace (comma-separated)
    local plugins_list=""
    while IFS= read -r plugin; do
      [[ -z "$plugin" ]] && continue
      if [[ -z "$plugins_list" ]]; then
        plugins_list="$plugin"
      else
        plugins_list="${plugins_list},${plugin}"
      fi
    done < <(read_plugins_for_marketplace "$_INSTALLED_PLUGINS_FILE" "$mp_name")

    # Skip if not found in known_marketplaces
    if [[ -z "$source_type" ]] && [[ -z "$install_dir" ]]; then
      record_mp_result "$mp_name" "unknown" "-" "-" "$plugins_list"
      warn "  [SKIPPED] ${mp_name}  not found in known marketplaces"
      mark_partial_failure
      continue
    fi

    # Default source type if not found
    source_type="${source_type:-unknown}"

    update_marketplace "$mp_name" "$source_type" "$install_dir" "$repo" "$plugins_list"
  done

  # Step 4: Print summary
  if [[ "$_JSON_MODE" -eq 1 ]]; then
    print_summary_json
  else
    print_summary_text
  fi

  # Step 5: Auto-reinstall if this plugin's own marketplace was updated
  # The plugin cache is a separate copy from the marketplace repo.
  # After git pull, the cache may be stale — reinstalling refreshes it.
  if [[ "$_DRY_RUN" -eq 0 ]] && [[ "$_CHECK_MODE" -eq 0 ]] && [[ "$_JSON_MODE" -eq 0 ]]; then
    local self_status
    self_status=$(get_mp_field "cc-update-all" 0 2>/dev/null || true)
    if [[ "$self_status" == "updated" ]]; then
      echo ""
      info "This plugin was updated. Refreshing cache..."
      if claude plugin install update-all-plugins@cc-update-all --scope user 2>/dev/null; then
        ok "Plugin cache refreshed. /reload-plugins to activate."
      else
        warn "Auto-reinstall failed. Run manually:"
        dim "  claude plugin install update-all-plugins@cc-update-all --scope user"
      fi
    fi
  fi

  # Exit code
  if check_partial_failure; then
    exit 1
  fi
  exit 0
}

main "$@"
