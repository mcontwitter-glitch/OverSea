#!/usr/bin/env bash
# Starts a fresh solana-test-validator with the LayerZero endpoint, simple message lib and Metaplex Core (no MultiSea
# program: the test deploys it the way the browser does), then runs scripts/test/solprog-local.ts.
set -euo pipefail
cd "$(dirname "$0")/../.."
BIN=${BIN:-/workspace/solana-work/bin}
export PATH=$HOME/.local/share/solana/install/active_release/bin:$PATH
pkill -f solana-test-validator || true; sleep 1
solana-test-validator --reset --quiet --ledger /tmp/msea-ledger-ui \
  --bpf-program 76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6 $BIN/endpoint.so \
  --bpf-program 6GsmxMTHAAiFKfemuM4zBjumTjNSX5CAiw4xSSXM2Toy $BIN/simple_messagelib.so \
  --bpf-program CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d $BIN/mpl_core.so >/tmp/msea-validator-ui.log 2>&1 &
for i in $(seq 1 60); do solana -u localhost cluster-version >/dev/null 2>&1 && break; sleep 1; done
sleep 3
npx tsx scripts/test/solprog-local.ts
