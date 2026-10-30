# MultiSea delivery service (UNAUDITED — regtest/signet by default)

Watches `SketchEscrow` for `OrderCreated`, inscribes the order's content as a Bitcoin Ordinal to the buyer's
taproot address (commit/reveal via `micro-ordinals` + `@scure/btc-signer`), waits for N confirmations,
collects M-of-N EIP-712 `Attest` signatures, submits `attestDelivery`, then (optionally) `release`.

## Flow / state machine (persisted in `STATE_PATH`, atomic JSON writes)
`queued → built (signed commit+reveal saved BEFORE broadcast) → commit_sent → reveal_sent → confirmed → attested → released`
plus `failed` (never broadcast; buyer refunds after deadline) and `closed` (order no longer Pending on-chain).
- Idempotent by orderId; restart rebroadcasts the *same* saved tx pair (no double inscription). Spent UTXOs are reserved.
- EVM logs read `EVM_CONFIRMATIONS` behind head, chunked by `EVM_MAX_BLOCK_RANGE`.
- Retries with exponential backoff (5s→10min). Pre-broadcast errors fail after `MAX_ATTEMPTS`; post-broadcast never gives up.
- Fee rate: mempool.space `/v1/fees/recommended` (esplora) or `estimatesmartfee` (rpc), capped by `MAX_FEE_RATE` (defers).
- Fee bumping: all txs signal RBF (nSequence 0xfffffffd). Automatic bumping is NOT implemented. For a stuck pair the
  operator can CPFP from the commit's change output (service-owned), or wait; RBF of the commit would also require
  re-signing the reveal (new inscription id).
  If the pair drops from mempool, the service rebroadcasts it.
- Before signing, every attester independently verifies: reveal has ≥ `BTC_MIN_CONFS`, output 0 pays the order's
  btcAddress, envelope decodes to exactly the deterministic expected content, inscriptionId = `<revealTxid>i0`.
- Typed data matches the contract exactly: domain `MultiSeaOrdinalEscrow`/`1`, `Attest(uint256 orderId,bytes32 btcTxid,bytes32 inscriptionIdHash,uint256 deadline)`,
  `btcTxid` = reveal txid as displayed, sigs sorted by ascending signer address.
- Keys only from env / `*_FILE`; logger redacts key-like fields. Mainnet refused unless `I_UNDERSTAND_MAINNET=yes`.

## Commands
```bash
npm install
cp .env.example .env            # fill in; put keys in ./secrets/*
npm run address                 # print the service wallet's funding address (public)
npm start                       # run loop
npm run once                    # one tick (cron-style)
npm run attester                # peer attester HTTP server (POST /attest), one per operator
npm run typecheck && npm test   # unit tests
npm run test:e2e                # bitcoind regtest + anvil end-to-end (needs bitcoind, foundry)
```
Modes: `ATTEST_MODE=dev` signs with all local keys (single node); `ATTEST_MODE=peer` signs with own key and
requests the rest from `PEER_URLS` (each peer re-verifies on its own BTC backend before signing).
