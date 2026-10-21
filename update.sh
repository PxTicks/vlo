#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_REPOSITORY="https://github.com/PxTicks/vlo.git"
DEFAULT_BRANCH="main"
BACKUP_ROOT="$SCRIPT_DIR/.vlo-update-backups"
STAGE_DIR=""
PLAN_DIR=""
PLAN_GIT_DIR=""
PLAN_INDEX=""
BACKUP_DIR=""
REPLACING_LOCAL_FILES=0
REPLACE_LOCAL_FILES=0
INSTALL_ARGS=()
PREVIEW_LIMIT=20

info()  { printf '\033[1;34m[INFO]\033[0m  %s\n' "$*"; }
error() { printf '\033[1;31m[ERROR]\033[0m %s\n' "$*" >&2; }

usage() {
    cat <<'USAGE'
Usage: ./update.sh [--replace-local-files] [installer options]

Fetch the latest vlo source, then rerun install.sh to update dependencies and
rebuild the frontend. Installer options such as --profiles and --update-node
are passed through unchanged. The installer ends by reporting whether the
ComfyUI-vlo node pack in your ComfyUI is new enough; it never changes ComfyUI.

If updating would replace or move a local file, the updater lists those files
and asks first; each one is saved under .vlo-update-backups/ before it is
touched. That covers tracked source files with local changes in a Git
checkout, and the first update of a folder downloaded as a GitHub ZIP, which
converts it into a Git checkout.

  --replace-local-files  Approve those changes without asking. Required when
                         the updater cannot prompt.
USAGE
}

cleanup() {
    local status=$?

    if [ -n "$STAGE_DIR" ] && [ -d "$STAGE_DIR" ]; then
        rm -rf -- "$STAGE_DIR"
        rmdir -- "$BACKUP_ROOT" 2>/dev/null || true
    fi
    if [ "$status" -ne 0 ] && [ "$REPLACING_LOCAL_FILES" -eq 1 ]; then
        if [ -d "$BACKUP_DIR" ]; then
            error "The update stopped partway. Local files it had already set aside are in ${BACKUP_DIR}; its MANIFEST.txt lists them."
        else
            error "The update stopped partway. None of the local files had been replaced; rerun the updater."
        fi
    fi
}
trap cleanup EXIT

# Git as the plan sees it: the plan's repository and index against this
# folder. The index holds the tree the folder is about to be reset to.
plan_git() {
    GIT_INDEX_FILE="$PLAN_INDEX" git --git-dir="$PLAN_GIT_DIR" --work-tree="$SCRIPT_DIR" "$@"
}

start_plan() {
    mkdir -p -- "$BACKUP_ROOT"
    # Staging inside the installation keeps the final .git move a rename.
    STAGE_DIR="$(mktemp -d "$BACKUP_ROOT/.stage.XXXXXX")"
    PLAN_DIR="$STAGE_DIR/plan"
    mkdir -p -- "$PLAN_DIR"
    : > "$PLAN_DIR/leftovers"
}

finish_plan() {
    rm -rf -- "$STAGE_DIR"
    STAGE_DIR=""
    rmdir -- "$BACKUP_ROOT" 2>/dev/null || true
}

# Print the first entries of a NUL-separated list, then how many were left out.
preview_list() {
    local title="$1" list="$2" count=0 path

    [ -s "$list" ] || return 0
    printf '\n%s\n' "$title"
    while IFS= read -r -d '' path; do
        count=$((count + 1))
        if [ "$count" -le "$PREVIEW_LIMIT" ]; then
            printf '    %s\n' "$path"
        fi
    done < "$list"
    if [ "$count" -gt "$PREVIEW_LIMIT" ]; then
        printf '    ... and %d more\n' "$((count - PREVIEW_LIMIT))"
    fi
}

manifest_section() {
    local title="$1" list="$2" path

    [ -s "$list" ] || return 0
    printf '\n%s\n' "$title"
    while IFS= read -r -d '' path; do
        printf '    %s\n' "$path"
    done < "$list"
}

# Move a file or folder into the backup at the same relative path, then remove
# any folders the move emptied so stale directory trees do not linger.
move_aside() {
    local path="$1" parent

    [ -e "$path" ] || [ -L "$path" ] || return 0
    mkdir -p -- "$BACKUP_DIR/$(dirname -- "$path")"
    mv -- "$path" "$BACKUP_DIR/$path"
    parent="$(dirname -- "$path")"
    while [ "$parent" != "." ] && rmdir -- "$parent" 2>/dev/null; do
        parent="$(dirname -- "$parent")"
    done
}

# Tracked paths whose local copy differs from the plan's index. A path
# reported missing may really be hidden behind a file or a symbolic link in
# one of its parent folders, or be occupied by a folder; a reset would delete
# either, or swap the link for an empty folder.
plan_tracked_changes() {
    local status path prefix rest

    : > "$PLAN_DIR/overwritten.all"
    : > "$PLAN_DIR/in-the-way.all"
    : > "$PLAN_DIR/linked.all"
    plan_git diff --name-status -z --no-renames |
        while IFS= read -r -d '' status && IFS= read -r -d '' path; do
            case "$status" in
                D)
                    prefix=""
                    rest="$path"
                    while :; do
                        case "$rest" in */*) ;; *) break ;; esac
                        prefix="${prefix:+$prefix/}${rest%%/*}"
                        rest="${rest#*/}"
                        if [ -L "$prefix" ]; then
                            printf '%s\0' "$prefix" >> "$PLAN_DIR/linked.all"
                            continue 2
                        elif [ ! -e "$prefix" ]; then
                            continue 2
                        elif [ ! -d "$prefix" ]; then
                            printf '%s\0' "$prefix" >> "$PLAN_DIR/in-the-way.all"
                            continue 2
                        fi
                    done
                    if [ -e "$path" ] || [ -L "$path" ]; then
                        printf '%s\0' "$path" >> "$PLAN_DIR/in-the-way.all"
                    fi
                    ;;
                *)
                    printf '%s\0' "$path" >> "$PLAN_DIR/overwritten.all"
                    ;;
            esac
        done
    sort -zu "$PLAN_DIR/overwritten.all" > "$PLAN_DIR/overwritten"
    sort -zu "$PLAN_DIR/in-the-way.all" > "$PLAN_DIR/in-the-way"
    sort -zu "$PLAN_DIR/linked.all" > "$PLAN_DIR/linked"

    # Refuse rather than replace a linked folder with a real one: the data
    # behind the link would survive, but vlo would stop seeing it.
    if [ -s "$PLAN_DIR/linked" ]; then
        error "These folders are symbolic links, but vlo tracks files inside them:"
        while IFS= read -r -d '' path; do
            printf '    %s\n' "$path" >&2
        done < "$PLAN_DIR/linked"
        error "Updating would replace each link with an empty folder. Move their contents into normal folders, then rerun the updater. Nothing was changed."
        exit 1
    fi
}

# Files a ZIP folder has that the fetched version does not track. Anything
# ignored by either the ZIP's own rules or the fetched version's rules is local
# data and stays put; the rest is source the new version no longer has.
plan_zip_leftovers() {
    local path record_source record_line record_pattern ignore_status item skip
    local rules="$STAGE_DIR/ignore-rules"
    local in_the_way_items=()

    mkdir -p -- "$rules"
    plan_git ls-tree -r -z --name-only HEAD |
        while IFS= read -r -d '' path; do
            case "$path" in
                .gitignore|*/.gitignore)
                    mkdir -p -- "$rules/$(dirname -- "$path")"
                    plan_git show "HEAD:$path" > "$rules/$path"
                    ;;
            esac
        done
    plan_git ls-files --others --exclude-standard --exclude=/.vlo-update-backups/ -z \
        > "$PLAN_DIR/candidates"
    ignore_status=0
    git -C "$rules" --git-dir="$PLAN_GIT_DIR" --work-tree="$rules" \
        check-ignore --no-index --stdin -z -v -n \
        < "$PLAN_DIR/candidates" > "$PLAN_DIR/candidate-rules" || ignore_status=$?
    if [ "$ignore_status" -gt 1 ]; then
        error "Git could not evaluate the new version's ignore rules."
        exit 1
    fi

    while IFS= read -r -d '' item; do
        in_the_way_items+=("$item")
    done < "$PLAN_DIR/in-the-way"
    # Records are source, line, pattern, path; an empty pattern means no rule
    # matched, and a negated one means the path is explicitly kept.
    while IFS= read -r -d '' record_source \
        && IFS= read -r -d '' record_line \
        && IFS= read -r -d '' record_pattern \
        && IFS= read -r -d '' path; do
        case "$record_pattern" in
            ""|"!"*) ;;
            *) continue ;;
        esac
        skip=0
        for item in ${in_the_way_items[@]+"${in_the_way_items[@]}"}; do
            case "$path" in "$item"/*) skip=1; break ;; esac
        done
        [ "$skip" -eq 1 ] || printf '%s\0' "${path%/}" >> "$PLAN_DIR/leftovers"
    done < "$PLAN_DIR/candidate-rules"
}

# List what the plan would replace or move, ask (unless approved up front),
# then save each file under a new backup folder. Nothing is asked when nothing
# local would change.
confirm_and_back_up() {
    local label="$1" intro="$2" activity="$3" leftover_title="$4" answer path

    BACKUP_DIR="$BACKUP_ROOT/${label}-$(date -u +%Y%m%dT%H%M%SZ)"
    if [ ! -s "$PLAN_DIR/overwritten" ] && [ ! -s "$PLAN_DIR/in-the-way" ] \
        && [ ! -s "$PLAN_DIR/leftovers" ]; then
        return 0
    fi

    printf '\n'
    info "$intro"
    preview_list "Differ from vlo's version (a copy is saved, then the file is replaced):" \
        "$PLAN_DIR/overwritten"
    preview_list "In the way of vlo's files (moved into the backup):" "$PLAN_DIR/in-the-way"
    preview_list "$leftover_title (moved into the backup):" "$PLAN_DIR/leftovers"
    printf '\nEverything listed is saved under %s\n\n' "${BACKUP_DIR#"$SCRIPT_DIR"/}"

    if [ "$REPLACE_LOCAL_FILES" -eq 0 ]; then
        if [ ! -t 0 ]; then
            error "Rerun the updater from a terminal to approve these changes, or pass --replace-local-files. Nothing was changed."
            exit 1
        fi
        read -r -p "Continue? [y/N] " answer
        case "$answer" in
            y|Y|yes|YES|Yes) ;;
            *)
                info "Update cancelled. Nothing was changed."
                exit 1
                ;;
        esac
    fi

    REPLACING_LOCAL_FILES=1
    mkdir -p -- "$BACKUP_DIR"
    {
        printf 'Saved by update.sh on %s while %s.\n' \
            "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$activity"
        printf 'Each entry is stored at its original path relative to the vlo folder.\n'
        manifest_section "Copied, then replaced by vlo's version:" "$PLAN_DIR/overwritten"
        manifest_section "Moved aside because it was in the way of vlo's files:" \
            "$PLAN_DIR/in-the-way"
        manifest_section "Moved aside; ${leftover_title}:" "$PLAN_DIR/leftovers"
    } > "$BACKUP_DIR/MANIFEST.txt"

    while IFS= read -r -d '' path; do
        mkdir -p -- "$BACKUP_DIR/$(dirname -- "$path")"
        cp -pRP -- "$path" "$BACKUP_DIR/$path"
    done < "$PLAN_DIR/overwritten"
    while IFS= read -r -d '' path; do
        move_aside "$path"
    done < "$PLAN_DIR/in-the-way"
    while IFS= read -r -d '' path; do
        move_aside "$path"
    done < "$PLAN_DIR/leftovers"
}

report_backup() {
    if [ -d "$BACKUP_DIR" ]; then
        info "Saved the replaced and moved files to ${BACKUP_DIR}"
    fi
}

update_git_checkout() {
    if ! git -C "$SCRIPT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        error "The .git entry exists but is not a usable Git checkout."
        exit 1
    fi

    # Plan against a scratch index holding HEAD, so the checkout's own index
    # (and anything staged in it) is untouched unless the reset is approved.
    start_plan
    PLAN_GIT_DIR="$(git -C "$SCRIPT_DIR" rev-parse --absolute-git-dir)"
    PLAN_INDEX="$STAGE_DIR/index"
    plan_git read-tree HEAD
    plan_tracked_changes
    # Files added to the checkout's index but never committed: a reset to HEAD
    # deletes them.
    git -C "$SCRIPT_DIR" diff --cached --name-only --diff-filter=A --no-renames -z \
        > "$PLAN_DIR/leftovers"

    confirm_and_back_up "local-changes" \
        "Updating will discard local changes to these files:" \
        "discarding local changes before updating a Git checkout" \
        "Added locally, not part of vlo"
    if [ "$REPLACING_LOCAL_FILES" -eq 1 ]; then
        git -C "$SCRIPT_DIR" reset --hard --quiet HEAD
        REPLACING_LOCAL_FILES=0
        report_backup
    fi
    finish_plan

    info "Fetching updates for the existing Git checkout..."
    if ! git -C "$SCRIPT_DIR" pull --ff-only; then
        error "Git could not fast-forward this checkout. Resolve its branch or upstream configuration, then rerun the updater."
        exit 1
    fi
}

convert_zip_installation() {
    local repository="${VLO_UPDATE_REPOSITORY:-$DEFAULT_REPOSITORY}"
    local branch="${VLO_UPDATE_BRANCH:-$DEFAULT_BRANCH}"

    start_plan
    PLAN_GIT_DIR="$STAGE_DIR/repository/.git"
    PLAN_INDEX="$PLAN_GIT_DIR/index"

    info "This vlo folder is not a Git checkout; preparing to convert the ZIP installation..."
    git clone --depth 1 --branch "$branch" --no-checkout "$repository" "$STAGE_DIR/repository"
    plan_git read-tree HEAD
    plan_tracked_changes
    plan_zip_leftovers

    confirm_and_back_up "zip-import" \
        "Converting this folder to a Git checkout will change these local files:" \
        "converting a ZIP installation into a Git checkout of ${repository} (${branch})" \
        "No longer part of vlo"

    REPLACING_LOCAL_FILES=1
    plan_git reset --hard --quiet HEAD
    mv -- "$PLAN_GIT_DIR" "$SCRIPT_DIR/.git"
    REPLACING_LOCAL_FILES=0
    finish_plan

    report_backup
    info "Converted this folder to a Git checkout tracking ${repository} (${branch})."
}

for argument in "$@"; do
    case "$argument" in
        -h|--help)
            usage
            exit 0
            ;;
        --replace-local-files) REPLACE_LOCAL_FILES=1 ;;
        *) INSTALL_ARGS+=("$argument") ;;
    esac
done

info "vlo Updater"
printf '\n'

if ! command -v git >/dev/null 2>&1 || ! git --version >/dev/null 2>&1; then
    error "Git is required to update vlo. Install it from https://git-scm.com/downloads, then rerun this script."
    exit 1
fi

if [ ! -f "$SCRIPT_DIR/install.sh" ] || [ ! -f "$SCRIPT_DIR/package.json" ]; then
    error "This script must remain in the root of a vlo installation."
    exit 1
fi

cd "$SCRIPT_DIR"

if [ -e "$SCRIPT_DIR/.git" ]; then
    update_git_checkout
else
    convert_zip_installation
fi

printf '\n'
info "Rebuilding vlo with the updated installer..."
"$SCRIPT_DIR/install.sh" ${INSTALL_ARGS[@]+"${INSTALL_ARGS[@]}"}
