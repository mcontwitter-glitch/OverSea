#!/usr/bin/env bash
# LOCAL end-to-end: bitcoind regtest + anvil. Nothing touches a public chain or a real wallet.
# Requires: bitcoind/bitcoin-cli (v28), foundry (anvil/forge/cast), node 20.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"; ROOT="${FORGE_ROOT:-$(cd "$HERE/../../contracts" && pwd)}"
W="$(mktemp -d)"; BTC_PORT=${BTC_PORT:-18543}; EVM_PORT=${EVM_PORT:-8546}; PEER_PORT=${PEER_PORT:-8797}
RPCPASS="$(openssl rand -hex 16)"
cleanup() { kill ${ANVIL_PID:-} ${PEER_PID:-} 2>/dev/null || true; bitcoin-cli -regtest -datadir="$W/btc" -rpcport=$BTC_PORT -rpcuser=u -rpcpassword="$RPCPASS" stop >/dev/null 2>&1 || true; }
trap cleanup EXIT
mkdir -p "$W/btc" "$W/keys"
BCLI() { bitcoin-cli -regtest -datadir="$W/btc" -rpcport=$BTC_PORT -rpcuser=u -rpcpassword="$RPCPASS" "$@"; }

echo "== bitcoind regtest"
bitcoind -regtest -daemon -datadir="$W/btc" -rpcport=$BTC_PORT -port=$((BTC_PORT+1)) -rpcuser=u -rpcpassword="$RPCPASS" \
  -txindex=1 -fallbackfee=0.0001 -listen=0 >/dev/null
for i in $(seq 50); do BCLI getblockchaininfo >/dev/null 2>&1 && break; sleep 0.3; done
BCLI createwallet miner >/dev/null
MINER=$(BCLI -rpcwallet=miner getnewaddress)
BCLI generatetoaddress 101 "$MINER" >/dev/null
BUYER_BTC=$(BCLI -rpcwallet=miner getnewaddress buyer bech32m)   # buyer's taproot address (regtest)

echo "== anvil"
anvil --port $EVM_PORT --silent & ANVIL_PID=$!
for i in $(seq 50); do cast chain-id --rpc-url http://127.0.0.1:$EVM_PORT >/dev/null 2>&1 && break; sleep 0.2; done
EVM=http://127.0.0.1:$EVM_PORT
# anvil's PUBLIC well-known dev keys (local only)
K=(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
   0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca120fc212f4e3d8f4b2b16 0x7c852118294e51e1f45fc9ac17ad5c5b52b6e7efc81e1b1b0b3ad6b4c3e0e6c6
   0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a)
ADDR() { cast wallet address --private-key "$1"; }
ATT1=$(ADDR ${K[1]}); ATT2=$(ADDR ${K[2]}); ATT3=$(ADDR ${K[3]}); BUYER=$(ADDR ${K[4]})
ARTIST=0x000000000000000000000000000000000000A271; FEE=0x000000000000000000000000000000000000FEE1

echo "== forge script DeployLocal -> anvil"
cd "$ROOT"
OUT=$(DEPLOYER_PK=${K[0]} ATTESTERS=$ATT1,$ATT2,$ATT3 BUYER=$BUYER ARTIST=$ARTIST FEE_RECIPIENT=$FEE \
  forge script script/ordinals/DeployOrdinalsLocal.s.sol:DeployLocal --rpc-url $EVM --broadcast 2>&1)
USDC=$(echo "$OUT" | awk '/USDC 0x/{print $2}'); ESCROW=$(echo "$OUT" | awk '/ESCROW 0x/{print $2}')
echo "USDC=$USDC ESCROW=$ESCROW"
START=$(cast block-number --rpc-url $EVM)

echo "== service keys (files, 0600)"
umask 077
openssl rand -hex 32 > "$W/keys/btc_service"
printf '%s' "${K[1]}" > "$W/keys/attester1"; printf '%s' "${K[3]}" > "$W/keys/attester3"
cd "$HERE"
COMMON=(BTC_NETWORK=regtest BTC_BACKEND=rpc BITCOIND_RPC_URL=http://127.0.0.1:$BTC_PORT BITCOIND_RPC_USER=u BITCOIND_RPC_PASS=$RPCPASS
  EVM_RPC_URL=$EVM ESCROW_ADDRESS=$ESCROW START_BLOCK=$START EVM_CONFIRMATIONS=1 BTC_MIN_CONFS=3 FEE_RATE_FALLBACK=2
  BTC_SERVICE_PRIVKEY_FILE=$W/keys/btc_service POLL_MS=500 DEADLINE_SAFETY_SECS=600 PEER_AUTH_TOKEN=e2e-token DOTENV=/nonexistent)
SVC_ADDR=$(env "${COMMON[@]}" npx tsx src/index.ts address)
echo "service wallet: $SVC_ADDR"
BCLI -rpcwallet=miner sendtoaddress "$SVC_ADDR" 0.002 >/dev/null; BCLI generatetoaddress 1 "$MINER" >/dev/null

echo "== peer attester #3 (independently verifies before signing)"
env "${COMMON[@]}" ATTESTER_PRIVATE_KEY_FILE=$W/keys/attester3 ATTEST_SERVER_PORT=$PEER_PORT npx tsx src/index.ts attester > "$W/peer.log" 2>&1 & PEER_PID=$!
sleep 2

echo "== buyer createOrder (25 mUSDC)"
CID=$(cast keccak "multisea-demo")
cast send --rpc-url $EVM --private-key ${K[4]} $USDC "approve(address,uint256)" $ESCROW 25000000 >/dev/null
cast send --rpc-url $EVM --private-key ${K[4]} $ESCROW "createOrder(bytes32,address,string)" $CID $USDC "$BUYER_BTC" >/dev/null
cast rpc --rpc-url $EVM anvil_mine 2 >/dev/null

echo "== run service (each 'once' = fresh process => exercises restart safety)"
SVC=(env "${COMMON[@]}" ATTEST_MODE=peer ATTESTER_PRIVATE_KEY_FILE=$W/keys/attester1 PEER_URLS=http://127.0.0.1:$PEER_PORT STATE_PATH=$W/state.json)
STATE=""
for i in $(seq 15); do
  "${SVC[@]}" npx tsx src/index.ts once >> "$W/svc.log" 2>&1 || true
  STATE=$(node -e 'const s=require(process.argv[1]);console.log(s.jobs["1"]?.state??"none")' "$W/state.json" 2>/dev/null || echo none)
  echo "  iter $i: order 1 state=$STATE"
  [ "$STATE" = released ] && break
  BCLI generatetoaddress 1 "$MINER" >/dev/null
done
# re-run once more: must be a no-op (idempotent)
"${SVC[@]}" npx tsx src/index.ts once >> "$W/svc.log" 2>&1

echo "== assertions"
REVEAL=$(node -e 'console.log(require(process.argv[1]).jobs["1"].revealTxid)' "$W/state.json")
INSID=$(node -e 'console.log(require(process.argv[1]).jobs["1"].inscriptionId)' "$W/state.json")
fail() { echo "FAIL: $*"; echo "--- svc.log"; tail -30 "$W/svc.log"; echo "--- peer.log"; tail -10 "$W/peer.log"; exit 1; }
[ "$STATE" = released ] || fail "order not released (state=$STATE)"
RT=$(BCLI getrawtransaction "$REVEAL" true)
CONFS=$(echo "$RT" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).confirmations))')
DEST=$(echo "$RT" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).vout[0].scriptPubKey.address))')
[ "$DEST" = "$BUYER_BTC" ] || fail "reveal pays $DEST, expected $BUYER_BTC"
[ "$CONFS" -ge 3 ] || fail "reveal confs $CONFS < 3"
BUYER_HAS=$(BCLI -rpcwallet=miner listunspent 0 9999999 "[\"$BUYER_BTC\"]" | grep -c "$REVEAL" || true)
[ "$BUYER_HAS" -ge 1 ] || fail "buyer wallet does not hold inscription output"
ENVELOPE=$(node --import tsx -e '
  import("./src/btc/inscribe.ts").then(async m=>{const {REGTEST}=await import("./src/btc/networks.ts");
  const d=m.decodeReveal(process.argv[1],REGTEST);const i=d.inscriptions[0];
  console.log(i.tags.contentType+" "+Buffer.from(i.body).toString().slice(0,60))})' "$(BCLI getrawtransaction "$REVEAL")")
echo "inscription $INSID ($CONFS confs) -> $DEST"
echo "envelope: $ENVELOPE..."
ORD=$(cast call --rpc-url $EVM $ESCROW "orders(uint256)(address,address,uint128,uint64,uint8,bytes32,string,bytes32,string)" 1)
STATUS=$(echo "$ORD" | sed -n 5p); ONCHAIN_INS=$(echo "$ORD" | sed -n 9p | tr -d '"')
[ "$STATUS" = 3 ] || fail "onchain status $STATUS != Released(3)"
[ "$ONCHAIN_INS" = "$INSID" ] || fail "onchain inscriptionId $ONCHAIN_INS != $INSID"
A=$(cast call --rpc-url $EVM $USDC "balanceOf(address)(uint256)" $ARTIST | awk '{print $1}')
F=$(cast call --rpc-url $EVM $USDC "balanceOf(address)(uint256)" $FEE | awk '{print $1}')
[ "$A" = 23750000 ] || fail "artist balance $A"; [ "$F" = 1250000 ] || fail "fee balance $F"
grep -q "signed attestation" "$W/peer.log" || fail "peer never signed"
if grep -Eiq "$(cat "$W/keys/btc_service")|${K[1]#0x}|${K[3]#0x}|$RPCPASS" "$W/svc.log" "$W/peer.log"; then fail "secret leaked into logs"; fi
echo "artist=$A fee=$F orderStatus=Released"
echo "E2E PASS"
