#!/usr/bin/env bash
# Verify the launchpad testnet contracts. Etherscan V2 key (multichain) is read from ETHERSCAN_ENV, never printed.
#   Base Sepolia + Sepolia: Etherscan V2 · Robinhood testnet: Sourcify
set -uo pipefail
cd "$(dirname "$0")/.."
export PATH=$HOME/.foundry/bin:$PATH
set -a; . "${ETHERSCAN_ENV:-/workspace/foot-wallets/contracts/.etherscan.env}"; set +a
S=deployments/launchpad-testnet.json; T=../config/launchpad.testnet.json
ADMIN=$(jq -r .admin $T); FEE=$(jq -r .feeWallet $T); DEP=$(jq -r .deployer $S); APP=$(jq -r .approver $S); DELAY=$(jq -r .timelockDelaySec $T)
for k in ${NETS:-baseSepolia sepolia robinhoodTestnet}; do
  id=$(jq -r ".chains.$k.chainId" $T); ep=$(jq -r ".chains.$k.endpoint" $T); mv=$(jq -r ".chains.$k.moveFee" $T)
  # Robinhood testnet: Blockscout rejected the submission ("Unable to verify"); Sourcify (full match) works.
  if [ "$k" = robinhoodTestnet ]; then V=(--verifier sourcify); else V=(--verifier etherscan --etherscan-api-key "$ETHERSCAN_API_KEY"); fi
  a() { jq -r ".chains.$k.$1" $S; }
  run() { echo "== $k $2"; forge verify-contract "$1" "$2" --chain-id $id "${V[@]}" --watch "${@:3}" 2>&1 | grep -E "Pass|Fail|already|verified|Error|error" | grep -v "^\s*$" | tail -2; }
  run $(a timelock) src/launchpad/MultiSeaTimelock.sol:MultiSeaTimelock --constructor-args $(cast abi-encode 'c(uint256,address[],address[])' $DELAY "[$ADMIN]" "[$ADMIN]")
  run $(a dropImpl) src/launchpad/MultiSeaDrop.sol:MultiSeaDrop
  run $(a omniImpl) src/launchpad/MultiSeaOmniDrop.sol:MultiSeaOmniDrop
  run $(a escrow) src/launchpad/MultiSeaOmniEscrow.sol:MultiSeaOmniEscrow --constructor-args $(cast abi-encode 'c(address,address,address,uint256)' $ep $DEP $FEE $mv)
  run $(a factory) src/launchpad/MultiSeaLaunchpadFactory.sol:MultiSeaLaunchpadFactory --constructor-args $(cast abi-encode 'c(address,address,address,address,uint16)' $DEP $(a dropImpl) $FEE $APP 50)
done
