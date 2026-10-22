# MultiSea launchpad: testnet deployment (spec §14 L2)

TESTNETS ONLY. Unaudited preview contracts. Nothing on mainnet changed; the live Worker `multisea-api` and live gh-pages were not touched.
Deployed 2026-10-22 (America/New_York) by the testnet deployer `0x0F84abC1CE26fCa7Ed8c733603BD91a88032be4F` (key in `contracts/.secrets/`, gitignored, never printed).
Machine-readable: `config/launchpad.testnet.json` (addresses, DVNs, drop) and `contracts/deployments/launchpad-testnet.json` (every tx hash).

## Preview defaults used for the open decisions
| Decision | Testnet value |
|---|---|
| Platform fee | 0.5% (`platformFeeBps = 50`) to the fee wallet `0x25411039F77529A543344603bD8acdd65fABA4d0` |
| Who deploys a drop | the creator (`createDrop` / `createOmniDrop`, signed approval from the MultiSea approver) |
| Approver (testnet) | `0xEfE2b6C0938b488a251B96423794e09Bb776773E`: a NEW testnet-only key (`contracts/.secrets/staging-approver.key`), also the staging Worker's `LAUNCHPAD_APPROVER_KEY` secret |
| Timelock | `MultiSeaTimelock` (OZ TimelockController): proposer + executor = admin wallet `0xca89ae48a5c61d13e78236daa4ac29ee588ea475`, no admin role. **Delay 300 s (5 min) on testnets; 48 h on mainnet** |
| Multichain mode | BATCHED escrow copies, defaults K = 50 / T = 30 min (the smoke drop uses K = 10, the contract minimum, and T = 5 min) |
| Supply hub | Base Sepolia (EID 40245) |

## Per-chain status
| Chain | Status | LayerZero |
|---|---|---|
| Base Sepolia (84532) | deployed, wired, verified (Etherscan V2) | hub; peers Sepolia + Robinhood testnet |
| Sepolia (11155111) | deployed, wired, verified (Etherscan V2) | peers Base Sepolia + Robinhood testnet |
| Robinhood testnet (46630) | deployed, wired, verified (Sourcify, full match) | **LayerZero V2 is supported** (endpoint `0x3aCAAf60502791D199a5a5F0B173D78229eBFe32`, EID 40451): pathways to Base Sepolia, Sepolia, BNB testnet exist; **no pathway to/from ApeChain Curtis**. Executor Robinhood -> Base Sepolia has `nativeCap = 0` (see limitations). Included in multichain. |
| BNB testnet (97) | **blocked: deployer has 0 tBNB** | pathways exist to all four others |
| ApeChain Curtis (33111) | **blocked: deployer has 1 APE, deploy + wire needs ≈2.5 APE** (gas ≈102 gwei) | endpoint `0x6C7Ab2202C98C4227C5c46f1417D81144DA716Ff`, EID 40306; no pathway to Robinhood testnet; executor Curtis -> Base Sepolia `nativeCap = 0` |

**Funding needed** (address `0x0F84abC1CE26fCa7Ed8c733603BD91a88032be4F`): BNB testnet **≥ 0.1 tBNB** (deploy + wire ≈ 0.0012 tBNB at 0.05 gwei, rest for LayerZero fees and a smoke mint), ApeChain Curtis **≥ 2 more APE (3 recommended)**. Then: `node scripts/lp-testnet.mjs deploy bscTestnet curtis && node scripts/lp-testnet.mjs wire` (re-wires every chain), `scripts/lp-testnet-verify.sh` with `NETS="bscTestnet curtis"`, export, new smoke drop.

## Contracts
| Chain | Timelock | MultiSeaDrop impl | MultiSeaOmniDrop impl | MultiSeaOmniEscrow | MultiSeaLaunchpadFactory |
|---|---|---|---|---|---|
| Base Sepolia | [0x1613BA30…C47](https://sepolia.basescan.org/address/0x1613BA308bCF89F07C80E54F9f7b99269dC48C47#code) | [0x3dE96B4e…a3a](https://sepolia.basescan.org/address/0x3dE96B4ea712F3682bDD7c0B90b23efcd3110a3a#code) | [0x00b7103e…b24](https://sepolia.basescan.org/address/0x00b7103eE06F8614eA676a906EC9989a98212b24#code) | [0xfA290d09…81F](https://sepolia.basescan.org/address/0xfA290d09902d50Ec980Eb42e6348892f8b46f81F#code) | [0xa351fB6d…47F](https://sepolia.basescan.org/address/0xa351fB6dDEe84DF95025ECB54A68CAEd3Fb0A47F#code) |
| Sepolia | [0x00b7103e…b24](https://sepolia.etherscan.io/address/0x00b7103eE06F8614eA676a906EC9989a98212b24#code) | [0xfA290d09…81F](https://sepolia.etherscan.io/address/0xfA290d09902d50Ec980Eb42e6348892f8b46f81F#code) | [0xa351fB6d…47F](https://sepolia.etherscan.io/address/0xa351fB6dDEe84DF95025ECB54A68CAEd3Fb0A47F#code) | [0xbd943A51…F0f](https://sepolia.etherscan.io/address/0xbd943A51Be215A2e0dc8A8B22124A148eef64F0f#code) | [0x0920f7B5…C79](https://sepolia.etherscan.io/address/0x0920f7B5A6fc50FFA0aa85A23522665Da954FC79#code) |
| Robinhood testnet | [0xED82E859…e33](https://explorer.testnet.chain.robinhood.com/address/0xED82E859C3ee532f904c34866dafeF0bCf9dbe33) | [0xf374Eae4…F2F](https://explorer.testnet.chain.robinhood.com/address/0xf374Eae4b2163AecEB2C0541Fcd2E50B0FE63F2F) | [0x7b993C1d…aE7](https://explorer.testnet.chain.robinhood.com/address/0x7b993C1d0346866b20d30ebcd570D4e225aEeaE7) | [0x1613BA30…C47](https://explorer.testnet.chain.robinhood.com/address/0x1613BA308bCF89F07C80E54F9f7b99269dC48C47) | [0x3dE96B4e…a3a](https://explorer.testnet.chain.robinhood.com/address/0x3dE96B4ea712F3682bDD7c0B90b23efcd3110a3a) |

(Same-looking addresses on different chains are a coincidence of the deployer's nonces; they are different contracts.) Robinhood sources: `https://sourcify.dev/server/v2/contract/46630/<address>`.

**LayerZero wiring** (`scripts/lp-testnet.mjs wire`): `setPeer` for every supported pathway, and the ULN (DVN) send + receive config **pinned explicitly** on each escrow to today's LayerZero testnet default for that pathway (1 required DVN, LayerZero Labs; confirmations 1-5 per pathway, see `dvn` in `config/launchpad.testnet.json`), so a default change can't alter it. "Enforced options": the escrow builds its own executor options per message kind from `gasOf` (owner/timelock-tunable); testnet values were raised (MOVE 400k, CONFIRM/COPY/BATCH 200k + 170k per ID) because **Sepolia currently charges ≈3x mainnet execution gas** (and ≈7x for contract creation).

**Ownership**: escrows and factories are still owned by the deployer so BNB testnet / Curtis can be wired once funded. Final step (not run yet): `node scripts/lp-testnet.mjs handoff`: LayerZero delegate + escrow ownership -> timelock immediately; factory ownership -> timelock is two-step (`Ownable2Step`), so the admin wallet then schedules and, after 5 min, executes `factory.acceptOwnership()` (selector `0x79ba5097`) through the timelock on each chain.

## End-to-end smoke test (real testnet transactions)
Drop **MultiSea Smoke** (`MSMOKE`), slug `smoke-1792642666`, collectionId `0xfbabd7a1e2c03eff81d5ae455354d3698ae4ed7ffc541a0b73a402bb41faaee7`, supply 20 shared across Base Sepolia / Sepolia / Robinhood testnet, price 0.00001 ETH, BATCHED K = 10, T = 5 min.
Drops: Base Sepolia [0x9cFa6781…DE70](https://sepolia.basescan.org/address/0x9cFa67815E3793fcF620a97E1E5Ef50d45a3DE70), Sepolia [0xB6aF5231…7250](https://sepolia.etherscan.io/address/0xB6aF523158651464b0eC40fC2685A1F19Bb27250), Robinhood testnet [0x9462f787…0F5](https://explorer.testnet.chain.robinhood.com/address/0x9462f78767B9C8D0E40d70d4600F1A73f2ceB0F5).

| # | Step | Tx |
|---|---|---|
| 1 | createOmniDrop on the 3 chains (approval signed by the testnet approver, same collectionId) | [Base Sepolia](https://sepolia.basescan.org/tx/0xd1f4d4f0b50de1126f7526a0df49756d5057af3535960fbc741295bc9e31c26b) · [Sepolia](https://sepolia.etherscan.io/tx/0xfe7b655080bb7b4cbc1835551ec149ff6c9d00494973970df67f35d32da90a91) · [Robinhood](https://explorer.testnet.chain.robinhood.com/tx/0x423b7e8edcd99853ff7cbc88cd9ffd3f4c3f0d00591e5c2db7ab2aa3750c1c67) |
| 2 | Mint 3 on Base Sepolia (hub): #1-#3 Active instantly, copies queued, pool share 0.0000739 ETH | [tx](https://sepolia.basescan.org/tx/0x25b4455d5f768ca1b93d79a7ac63d794cd47fd7f55c06a46fa9f4c89cdf64c8d) |
| 3 | Mint 7 on Sepolia: REQUEST -> hub assigns #4-#10 | [tx](https://sepolia.etherscan.io/tx/0xf849a5508e73dc7162710cd3e3eb88fff1f2b6ced577acc269609e419d047b07) · [LZ](https://testnet.layerzeroscan.com/tx/0xf849a5508e73dc7162710cd3e3eb88fff1f2b6ced577acc269609e419d047b07) · hub [0xed00af72…](https://sepolia.basescan.org/tx/0xed00af7227f46d76e6382da4cd992d6fc77246e3ccb4340b3adc303445fb0509) |
| 3b | CONFIRM ran out of gas on Sepolia (405k given, 1.1M needed): delivered by a manual `endpoint.lzReceive` with more gas; gas limits then raised | [tx](https://sepolia.etherscan.io/tx/0xff44ad1d67f40b95f890b2ccc137cc58f978d2ce400f8d6eb1bdcb5875ba0619) |
| 4 | **Flush #1** (permissionless, K = 10 reached): one BATCH per chain from the pool | [tx](https://sepolia.basescan.org/tx/0xe083bd7ac66be5008fe9cf83b1b5b58049210c42d3ecc78487c23176156b6336) · [LZ](https://testnet.layerzeroscan.com/tx/0xe083bd7ac66be5008fe9cf83b1b5b58049210c42d3ecc78487c23176156b6336) · landed [Sepolia](https://sepolia.etherscan.io/tx/0xf705088bd19ab12a3166a05bccfcab4e0032b8000e80e5671d5afeb3fea2e181) (#1-#3) · [Robinhood](https://explorer.testnet.chain.robinhood.com/tx/0x67d755797bf67dbb974fca97255e71db69e8690328237ae37e72bd102a153b1a) (#1-#10) |
| 5 | Mint 2 on Robinhood testnet (no native drop: executor cap 0): hub assigns #11-#12, CONFIRM owed | [tx](https://explorer.testnet.chain.robinhood.com/tx/0x830d4b2051c59478d88bead7a0f3ac68f969ea325c1142b53ec2ff8ea8f8b98c) · hub [0x3a56fcf7…](https://sepolia.basescan.org/tx/0x3a56fcf7de3b40ea881b1404acbea208b129a70b8b46b4049ae5d28adaff49dc) |
| 5b | `retryLeg` pays the owed CONFIRM (anyone can) -> #11-#12 Active on Robinhood | [tx](https://sepolia.basescan.org/tx/0x682c5ac3e61c2bc9d3267f5064027cb7f2035ad5314329352593ec66aaddf373) · landed [Robinhood](https://explorer.testnet.chain.robinhood.com/tx/0x3084caebed8f66059a0d713d73f1ba4937da736d3fc97389e31d0af71f98d603) |
| 6 | **Move #1** Base Sepolia -> Sepolia (platform 0.0001 + LZ 0.000099 ETH): locked on Base, escrow copy released on Sepolia | [tx](https://sepolia.basescan.org/tx/0xb5f622066726c7634272c0b0e2ddc8dd63634622f8c70c0c138bdd8871604cb8) · [LZ](https://testnet.layerzeroscan.com/tx/0xb5f622066726c7634272c0b0e2ddc8dd63634622f8c70c0c138bdd8871604cb8) · landed [Sepolia](https://sepolia.etherscan.io/tx/0xb433028f8d9672d0b45e2a0e1607b7e60ae4a0befb0bedb91621a5d73ca087f1) |
| 7 | Staging UI (real wallet txs, see below): mint #16, #17 on Base Sepolia, #18 on Sepolia | [#16](https://sepolia.basescan.org/tx/0xad1964df57b445d152476f1056bc419567e08b153e5537a2b21f4112b22036d5) · [#17](https://sepolia.basescan.org/tx/0xbb10ceee3ed6c5197e599df2f314e6b46ca2b2515db0f712e23f176be75bfda8) · [#18](https://sepolia.etherscan.io/tx/0x4b677fd0cae29f3b52e55cf2b358014bbf93e4bd29fc40edfff46fd0cf609a0b) (hub [0x33c91a79…](https://sepolia.basescan.org/tx/0x33c91a79f6577fb9b008d58721ce69ad99f50ea07953fde2743d9b59dcbe512e)) |
| 8 | **Flush #2** (T-trigger, pool topped up 0.0000326 ETH): #11-#18 to the other chains | [tx](https://sepolia.basescan.org/tx/0xa1ef93f82e7b999c61309fa7d85bb68dce0afcfa2e8a713646789449555cc51d) · landed [Sepolia](https://sepolia.etherscan.io/tx/0xe3d867a36b3c503590c080336b79f97be59715f88bf3e6b032d08e30e47e8a33) · [Robinhood](https://explorer.testnet.chain.robinhood.com/tx/0x2254212ce55626f73e5c1085c93b7c0470fbf060c4957f3d8b25ee3301d58721) |

**Final on-chain state** (`node scripts/lp-testnet-smoke.mjs check`; A = Active, e = escrow copy): 18 / 20 assigned, queue empty, every ID exists on all 3 chains and is Active on exactly one.
```
baseSepolia       e A A e e e e e e e e e A A e A A e . .
sepolia           A e e A A A A A A A e e e e A e e A . .
robinhoodTestnet  e e e e e e e e e e A A e e e e e e . .
```

## Staging Worker
`https://multisea-api-staging.mcontwitter.workers.dev` (Cloudflare Worker `multisea-api-staging`, workers.dev only, own KV namespaces `multisea-api-staging-COLLECTIONS` / `-NONCES`, no crons, no R2). `worker/wrangler.staging.toml`; `LP_NETWORK = "testnet"` swaps the launchpad module to the testnet factories/escrows/chains (`/health` reports `"lpNetwork":"testnet"`); secret `LAUNCHPAD_APPROVER_KEY` = the testnet approver. The live `multisea-api` was not redeployed (it stays on 6ee328e4): the code path only activates when `LP_NETWORK` is set, and the live Worker was not redeployed.

## Staging UI
Build: `VITE_LP_TESTNET=1 VITE_API_BASE=https://multisea-api-staging.mcontwitter.workers.dev npx vite build --outDir dist-staging` (gitignored; the production build tree-shakes the page away). Page: `/launchpad/testnet` (`src/launchtestnet.ts`): shared supply bar read from the hub, chain picker (Base Sepolia pre-selected), on-chain quotes (`quoteMint`, `quoteHubValue`), batched cost line + "Unused batch buffer goes to MultiSea", real `mint` via the connected wallet (switches/adds the testnet), pending -> confirmed status, queued-copies status, permissionless Flush button, "Your NFTs" read with `ownerOf` on every chain, contract links. Served locally on `http://localhost:4300/launchpad/testnet` (a trycloudflare tunnel could not connect: outbound port 7844 is blocked on the box). Screenshots: `screens/launchpad/testnet-*.png` (`scripts/shots-launchpad-testnet.mjs` injects an EIP-6963 test wallet; signing happens in Node with the testnet key, never in the page).

## Findings / limitations
1. **Robinhood testnet + Curtis -> Base Sepolia: executor `nativeCap = 0`.** A mint there can't carry the hub budget, so the hub's CONFIRM is OWED until someone calls `retryLeg` (a MultiSea relayer on staging) and the copy-pool share is 0 (pool topped up by flush{value}). Mainnet caps checked read-only: Ethereum/BNB/ApeChain -> Base = 0.05 ETH, so this is testnet-only there; Robinhood mainnet not checked.
2. **Sepolia gas**: execution ≈3x and contract creation ≈7x mainnet. Destination gas is per message kind, not per destination chain, so raising it for Sepolia raises the LZ quote everywhere. Mainnet: keep the original values; consider per-destination gas (`gasOf[kind][eid]`) before audit.
3. **Partial batches cost more per ID than the per-mint share assumes** (share = full K-batch quote / K). T-triggered flushes needed small top-ups (0.0000326 ETH in flush #2). Works as designed (anyone can top up), but a MultiSea flush bot should budget for it.
4. Curtis <-> Robinhood testnet have no LayerZero pathway: once Curtis is deployed, direct moves between those two will revert at quote (moves via another chain still work; REQUEST/CONFIRM/BATCH only use the hub).
5. Ownership hand-off to the timelocks is prepared but not executed (see Ownership).
