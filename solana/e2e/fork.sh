#!/usr/bin/env bash
# Mainnet fork for fork.ts: Agave 4.2.2 test validator, mainnet feature set, the live MultiSea program's exact programdata at its
# address (upgrade authority swapped for a throwaway local key) and the accounts #33's delivery touches, cloned read-only.
set -euo pipefail
cd "$(dirname "$0")"
S=${S:-$HOME/.local/share/solana/install/releases/stable-e29e5d910f0c2b7176f58174e592e8488099ef75/solana-release/bin}
RPC=${RPC:-https://api.mainnet-beta.solana.com}
NEW=${1:-../target/deploy/multisea_omni.so}
pkill -f solana-test-validator || true; sleep 1
npx tsx fork-prep.ts "$RPC" >/tmp/fork-prep.log
solana-test-validator() { "$S/solana-test-validator" "$@"; }
solana-test-validator --reset --quiet --ledger /tmp/msea-fork-ledger --url "$RPC" --clone-feature-set \
  --clone-upgradeable-program 76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6 --clone-upgradeable-program CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d \
  --account-dir /tmp/fork-accts $(cat /tmp/fork-clone.txt) >/tmp/msea-fork-validator.log 2>&1 &
for i in $(seq 1 90); do "$S/solana" -u localhost cluster-version >/dev/null 2>&1 && break; sleep 1; done
sleep 3
[ "${NO_RUN:-}" = 1 ] || npx tsx fork.ts "$NEW"
