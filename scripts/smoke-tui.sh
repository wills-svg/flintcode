#!/usr/bin/env bash
set -euo pipefail

project_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
session="flintcode-smoke-$$"
home=$(mktemp -d "${HOME}/flintcode-smoke-home-XXXXXX")

cleanup() {
  tmux kill-session -t "$session" 2>/dev/null || true
  rm -rf "$home"
}
trap cleanup EXIT

if ! command -v tmux >/dev/null 2>&1; then
  printf 'smoke: tmux is required\n' >&2
  exit 1
fi

tmux new-session -d -s "$session" -x 110 -y 34 \
  "cd '$project_dir' && FLINTCODE_HOME='$home' node bin/flintcode --trust"

ready=0
for _ in $(seq 1 120); do
  screen=$(tmux capture-pane -p -t "$session" 2>/dev/null || true)
  if printf '%s' "$screen" | grep -q 'Enter send' &&
     ! printf '%s' "$screen" | grep -q 'loading session'; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  printf 'smoke: TUI did not become ready\n' >&2
  tmux capture-pane -p -t "$session" -S -80 >&2 || true
  exit 1
fi

tmux send-keys -t "$session" -l "/tools"
sleep 1
tmux send-keys -t "$session" Enter
sleep 2

screen=$(tmux capture-pane -p -t "$session" -S -80)
if ! printf '%s' "$screen" | grep -q 'Active tools'; then
  printf 'smoke: /tools did not render\n' >&2
  printf '%s\n' "$screen" >&2
  exit 1
fi

tmux send-keys -t "$session" -l "/quit"
sleep 1
tmux send-keys -t "$session" Enter
sleep 1

printf 'TUI smoke OK\n'
