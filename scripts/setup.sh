#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$REPO_ROOT"

echo 'Setup: Installing dependencies...'
npm ci

MAIN_REPO="${ORCA_ROOT_PATH:-}"
if [[ -z "$MAIN_REPO" ]]; then
  MAIN_REPO="$(git worktree list --porcelain | while IFS= read -r line; do
    if [[ "$line" == worktree\ * ]]; then
      printf '%s\n' "${line#worktree }"
      break
    fi
  done)"
fi

if [[ -z "$MAIN_REPO" || ! -d "$MAIN_REPO" ]]; then
  echo 'Setup: Main checkout unavailable; skipping local files.'
  exit 0
fi
MAIN_REPO="$(cd "$MAIN_REPO" && pwd -P)"
if [[ "$MAIN_REPO" == "$REPO_ROOT" ]]; then
  echo 'Setup: Main checkout; no local files to copy.'
  exit 0
fi

shopt -s nullglob
for source in "$MAIN_REPO"/.env "$MAIN_REPO"/.env.*; do
  [[ -f "$source" ]] || continue
  name="${source##*/}"
  [[ "$name" == .env.example ]] && continue
  if [[ ! -e "$REPO_ROOT/$name" && ! -L "$REPO_ROOT/$name" ]]; then
    cp "$source" "$REPO_ROOT/$name"
    echo "Setup: Copied $name"
  fi
done
shopt -u nullglob

if [[ ! -e "$REPO_ROOT/.env" && -f "$REPO_ROOT/.env.example" ]]; then
  cp "$REPO_ROOT/.env.example" "$REPO_ROOT/.env"
  echo 'Setup: Created .env from .env.example (set JEV_ROUTER_API_KEY before running).'
fi

if [[ -d "$MAIN_REPO/.scratch/shared" && ! -e "$REPO_ROOT/.scratch/shared" && ! -L "$REPO_ROOT/.scratch/shared" ]]; then
  mkdir -p "$REPO_ROOT/.scratch"
  ln -s "$(cd "$MAIN_REPO/.scratch/shared" && pwd -P)" "$REPO_ROOT/.scratch/shared"
  echo 'Setup: Linked .scratch/shared'
fi

if [[ ! -e "$REPO_ROOT/AGENTS.local.md" && ! -L "$REPO_ROOT/AGENTS.local.md" ]]; then
  if [[ -f "$REPO_ROOT/.scratch/shared/AGENTS.local.md" ]]; then
    ln -s .scratch/shared/AGENTS.local.md "$REPO_ROOT/AGENTS.local.md"
    echo 'Setup: Linked AGENTS.local.md'
  elif [[ -f "$MAIN_REPO/AGENTS.local.md" ]]; then
    ln -s "$MAIN_REPO/AGENTS.local.md" "$REPO_ROOT/AGENTS.local.md"
    echo 'Setup: Linked AGENTS.local.md'
  fi
fi

echo 'Setup: Workspace ready.'
