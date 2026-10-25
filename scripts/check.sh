#!/usr/bin/env bash
set -euo pipefail

project_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$project_dir"

printf '== build ==\n'
npm run build

printf '\n== unit tests ==\n'
npm run test:unit

printf '\n== smoke ==\n'
node bin/flintcode --version
node bin/flintcode config | head -8

printf '\ncheck OK\n'
