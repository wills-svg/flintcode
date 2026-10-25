#!/usr/bin/env bash
set -euo pipefail

project_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
node_bin=$(command -v node || true)
if [ -z "$node_bin" ]; then
  printf 'flintcode: node is not on PATH\n' >&2
  exit 1
fi
if [ ! -f "$project_dir/dist/src/cli/main.js" ]; then
  printf 'flintcode: build first: (cd %s && npm run build)\n' "$project_dir" >&2
  exit 1
fi

target_dir="${PREFIX:-/usr}/bin"
if [ ! -d "$target_dir" ] || [ ! -w "$target_dir" ]; then
  target_dir="$HOME/.local/bin"
  mkdir -p "$target_dir"
fi
target="$target_dir/flintcode"

cat > "$target" <<EOF
#!/usr/bin/env bash
exec "$node_bin" "$project_dir/bin/flintcode" "\$@"
EOF
chmod +x "$target"

theme_src="$project_dir/themes/flintcode.json"
theme_dest="$HOME/.flintcode/themes/flintcode.json"
if [ -f "$theme_src" ]; then
  mkdir -p "$HOME/.flintcode/themes"
  if [ ! -f "$theme_dest" ]; then
    cp "$theme_src" "$theme_dest"
    printf 'Installed theme %s\n' "$theme_dest"
  fi
fi

skill_src="$project_dir/docs/skills/flintcode-extension-creator"
skill_dest="$HOME/.flintcode/skills/flintcode-extension-creator"
if [ -f "$skill_src/SKILL.md" ]; then
  mkdir -p "$skill_dest"
  if [ ! -f "$skill_dest/SKILL.md" ]; then
    cp "$skill_src/SKILL.md" "$skill_dest/SKILL.md"
    printf 'Installed skill %s\n' "$skill_dest/SKILL.md"
  else
    printf 'Skill already installed at %s (left as-is)\n' "$skill_dest/SKILL.md"
  fi
fi

printf 'Installed %s\n' "$target"
case ":$PATH:" in
  *":$target_dir:"*) ;;
  *) printf 'Add %s to PATH to run `flintcode`.\n' "$target_dir" ;;
esac
