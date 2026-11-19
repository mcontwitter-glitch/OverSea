# Island's one-address wallets (IslandWalletFactory)

One wallet address per Island on Base, Ethereum, ApeChain, BNB Chain and Robinhood. Island NFT contracts are unchanged.

- `src/island/IslandWalletFactory.sol`: deployed with the deterministic deployer `0x4e59b44847b379578588920cA78FbF26c0B4956C`,
  salt `keccak256("MultiSea.IslandWalletFactory.v1")`, constructor arg owner = MC `0xb19F…96b1`, so it has the same
  address on every chain (see `config/island-wallet.json`). Creates the wallet implementation in its constructor (same address
  everywhere) and ERC-1167 wallet clones at `CREATE2(factory, keccak256(abi.encode(keccak256("multi-islands"), id)))`.
  It is also its own LayerZero V2 OApp. Its peer on every chain is its own address.
- `src/island/IslandWallet.sol`: the wallet. `owner()` = the Island holder on this chain while the Island is active here (not in
  the bridge escrow). That holder calls `execute` / `executeBatch`. On chains where the Island is locked, only
  `factory.lzReceive` can run calls. That needs a LayerZero message from the factory on the Island's live chain, sent by its
  live holder (`remoteExecute`). Replay protection comes from a per-wallet nonce, a deadline of at most 1 day, and a
  refusal if the Island is live on the destination.
- Configuration (`setChainConfig`) is once per chain and can't be changed afterwards: the Island contract, the endpoint, the
  other 4 chains, and the LayerZero DVN/executor settings copied from the Island bridge escrow. The owner can only add chains
  or change LayerZero settings, which is the same power the endpoint delegate has.

Deploy: MC uses https://multisea.io/deploy-island-wallets (2 txs per chain: Deploy, then Configure). The site switches the
Island wallet page to the one-address wallet only when all 5 chains are configured.

After any change to `src/island/*.sol`: `forge build && node ../scripts/island-wallet-artifact.mjs` (the address changes).
Tests: `forge test --match-path 'test/island/*'` (unit), `ISLAND_FORK=1 forge test --match-path test/island/IslandWalletFork.t.sol -vv`
(mainnet forks of all 5 chains: same address, receive before deploy, direct control, LayerZero relay from Robinhood to the
other 4 with real endpoints and copied DVN config, migration of #32's 0.004 ETH (Robinhood) and #31's 2 LIL FOOTS (Ethereum)).
