#!/usr/bin/env bash
# MAINNET program deploy for the MultiSea Solana program. MC runs this himself with HIS keypair; nothing here holds a key.
# Default is a dry run (build + cost estimate). Add --go to actually deploy (the solana CLI asks nothing more after that).
#   solana/deploy/deploy-program.sh --keypair /path/to/mc-wallet.json [--program-keypair solana/deploy/program-mainnet-keypair.json] [--go]
# - The program keypair is created on first run (keep it; it only decides the program id, it holds no funds).
# - The program is built with MULTISEA_OMNI_ID=<that id> (declare_id! must match).
# - Upgrade authority = MC's wallet (move it to a multisig later with `solana program set-upgrade-authority`).
set -euo pipefail
cd "$(dirname "$0")/.."
KP=""; PKP="deploy/program-mainnet-keypair.json"; GO=0; URL="https://api.mainnet-beta.solana.com"; PRIO=50000
while [ $# -gt 0 ]; do case "$1" in
  --keypair) KP="$2"; shift 2;; --program-keypair) PKP="$2"; shift 2;; --url) URL="$2"; shift 2;; --priority-micro-lamports) PRIO="$2"; shift 2;; --go) GO=1; shift;;
  *) echo "unknown arg $1"; exit 2;; esac; done
[ -n "$KP" ] || { echo "--keypair <MC's own wallet keypair file> is required"; exit 2; }
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH" RUSTUP_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-solana}"
[ -f "$PKP" ] || solana-keygen new --no-bip39-passphrase --silent -o "$PKP"
PID=$(solana-keygen pubkey "$PKP"); PAYER=$(solana-keygen pubkey "$KP")
echo "program id : $PID"; echo "payer/upgrade authority : $PAYER"; echo "cluster    : $URL"
touch programs/multisea_omni/src/lib.rs # the id comes from a proc macro reading the env, which cargo does not track: force a rebuild
MULTISEA_OMNI_ID="$PID" cargo build-sbf > /tmp/multisea-build.log 2>&1 || { tail -20 /tmp/multisea-build.log; exit 1; }
SO=target/deploy/multisea_omni.so; LEN=$(stat -c %s "$SO")
if ! python3 -c 'import sys
A="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"; n=0
for c in sys.argv[2]: n=n*58+A.index(c)
sys.exit(0 if n.to_bytes(32,"big") in open(sys.argv[1],"rb").read() else 1)' "$SO" "$PID"; then echo "ABORT: the built program does not embed $PID"; exit 1; fi
echo "build      : declare_id = $PID (checked in the .so)"
RENT=$(solana rent --url "$URL" $((LEN + 45)) --lamports | awk '/Rent-exempt minimum/{print $3}')
sol() { awk -v l="$1" 'BEGIN{printf "%.4f", l/1e9}'; }
BAL=$(solana balance --url "$URL" "$PAYER" --lamports | awk '{print $1}')
echo "program size : $LEN bytes"
echo "program rent : $(sol "$RENT") SOL locked in the program account (refundable if the program is ever closed)"
echo "need during deploy : ~$(sol $((2 * RENT + 50000000))) SOL (the write buffer is funded too, then closed and refunded)"
echo "payer balance : $(sol "$BAL") SOL"
if [ "$GO" != 1 ]; then echo; echo "Dry run only. Re-run with --go to deploy."; exit 0; fi
solana program deploy --url "$URL" --keypair "$KP" --program-id "$PKP" --upgrade-authority "$KP" --with-compute-unit-price "$PRIO" --max-sign-attempts 50 "$SO"
solana program show --url "$URL" "$PID"
echo; echo "Next: open /deploy-solana?program=$PID"
