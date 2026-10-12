# Multichain collection dashboard (OpenSea-style)
Static Vite + TypeScript site. Collections and chains live in `config/collections.json`. To add a collection, append it to `collections` with its `deployments` and `escrow`, then run `npm run data -- <slug>` and open `?c=<slug>`.

    npm i
    npm run data          # node --env-file=.env scripts/index.mjs  -> public/data/<slug>/
    #   flags: --skip-meta  --skip-chain  --chains=ethereum,robinhood
    npm run build         # dist/ is a static site (base '/' for the custom domain multisea.io)
    npx vite preview      # http://localhost:4173
    node scripts/screens.mjs   # screenshots (needs preview running)

`.env` holds OPENSEA_API_KEY. It's gitignored and only read by the Node pipeline, never bundled. Without the key, volume falls back to on-chain Seaport 1.6 OrderFulfilled sales, and listings and floor show "needs OpenSea API key".

## Wallet + Buy (via OpenSea)
- The Connect wallet button finds injected wallets through EIP-6963 (MetaMask, Rabby, Coinbase, OKX and others) and falls back to `window.ethereum`. On mobile it also offers deep links into the MetaMask and Coinbase in-app browsers. The "My items" filter shows the LIL FOOTS the connected wallet holds across all chains.
- Buy flow: refresh the live listing from the Worker, switch or add the chain, call `POST /fulfill` (OpenSea `fulfillment_data`), show a confirm screen (price, fees, chain, balance), encode the Seaport call with viem, send it, then show pending/success with an explorer link.
- `config/app.json` sets `apiBase` (the Worker URL). The site calls `GET {apiBase}/health` on load. Until the Worker answers, Buy stays disabled with a "Buying coming soon" tooltip and the site works in browse-only mode.

## Worker (worker/)
`GET /health`, `GET /listings/:chain/:contract/:id` (live best listing), `POST /fulfill {hash, chain, protocolAddress, fulfiller}`.
CORS is limited to multisea.io, www.multisea.io, mcontwitter-glitch.github.io and localhost. Input is validated against an allowlist of chains and LIL FOOTS contracts from the config, and there is a per-IP rate limit (30 requests a minute).

    cd worker && npm i
    npx wrangler login                     # once, in a browser
    npx wrangler secret put OPENSEA_API_KEY
    npx wrangler deploy                    # -> https://multisea-api.<subdomain>.workers.dev
    # once multisea.io is on Cloudflare: uncomment `routes` in wrangler.toml and deploy again -> https://api.multisea.io

Local test: put `OPENSEA_API_KEY=...` in `worker/.dev.vars` (gitignored), then run `npm run dev`. If you deploy without the custom domain, set `apiBase` in `config/app.json` to the workers.dev URL and rebuild.

## Custom domain
After the DNS records exist, run `scripts/switch-domain.sh`. It adds the CNAME file, sets the Pages custom domain and rebuilds with base `/`.
