#!/usr/bin/env bash
# Run ONLY after multisea.io DNS resolves to GitHub Pages (see README). Switches Pages to the custom domain.
set -euo pipefail
cd "$(dirname "$0")/.."
export GIT_AUTHOR_NAME=mcontwitter-glitch GIT_AUTHOR_EMAIL=mcontwitter-glitch@users.noreply.github.com GIT_COMMITTER_NAME=mcontwitter-glitch GIT_COMMITTER_EMAIL=mcontwitter-glitch@users.noreply.github.com
dig +short multisea.io A | grep -q 185.199 || { echo "multisea.io A records not live yet"; exit 1; }
echo multisea.io > public/CNAME
VITE_BASE=/ npx vite build && touch dist/.nojekyll
K=$(sed -n "s/^OPENSEA_API_KEY=//p" .env | cut -c1-8); [ -n "$K" ] && ! grep -rqF "$K" dist src worker/src config README.md
gh api -X PUT repos/mcontwitter-glitch/OverSea/pages -f cname=multisea.io
(cd dist && git add -A && git commit -qm "Deploy: custom domain multisea.io" && git push -q origin gh-pages)
sed -i "s#process.env.VITE_BASE || '/OverSea/'#process.env.VITE_BASE || '/'#" vite.config.ts
git add -A && git commit -qm "Use custom domain multisea.io" && git push -q
echo "Wait for the certificate, then: gh api -X PUT repos/mcontwitter-glitch/OverSea/pages -F https_enforced=true"
