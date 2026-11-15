#!/usr/bin/env bash
# Local e2e: anvil (EVM hub) + solana-test-validator with the real LayerZero endpoint, simple message lib and Metaplex Core.
set -euo pipefail
cd "$(dirname "$0")"
BIN=${BIN:-/workspace/solana-work/bin}   # endpoint.so, simple_messagelib.so, mpl_core.so dumped from devnet (solana program dump -u devnet <id>)
export PATH=$HOME/.local/share/solana/install/active_release/bin:$HOME/.foundry/bin:$PATH
pkill -f "anvil --port 8545" || true; pkill -f solana-test-validator || true; sleep 1
anvil --port 8545 --chain-id 84532 --silent >/dev/null 2>&1 &
solana-test-validator --reset --quiet --ledger /tmp/msea-ledger \
  --bpf-program 76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6 $BIN/endpoint.so \
  --bpf-program 6GsmxMTHAAiFKfemuM4zBjumTjNSX5CAiw4xSSXM2Toy $BIN/simple_messagelib.so \
  --bpf-program CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d $BIN/mpl_core.so \
  --bpf-program Abu55rcZKUwUvuMDbpNrHy28RF9A8PBasZa5BGGNWiA7 ../target/deploy/multisea_omni.so >/tmp/msea-validator.log 2>&1 &
for i in $(seq 1 60); do solana -u localhost cluster-version >/dev/null 2>&1 && break; sleep 1; done
sleep 3
[ "${NO_RUN:-}" = 1 ] || npx tsx e2e.ts
