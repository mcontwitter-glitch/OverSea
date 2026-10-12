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

## MultiSea platform
Routes: `/` (home with collection cards), `/c/<slug>` (collection page), `/submit`, `/admin`. GitHub Pages serves `404.html` as the SPA fallback (made by `scripts/postbuild.mjs`).
- **Static collections** come from `config/collections.json` and the pipeline's `public/data/<slug>`. LIL FOOTS is the featured one.
- **Community collections** are submitted at `/submit`. The submitter signs a SIWE message, and contracts are checked on-chain with ERC-721 `supportsInterface`. An admin approves them at `/admin`, then they're stored in KV. Their items, listings and stats come live from the Worker's OpenSea proxy, with caching.
- **Owner edits:** the "Edit collection" button appears for the contract `owner()` on any of the collection's chains, the approved submitter, an admin, or a STATIC_EDITORS wallet. Logo, banner, description and links changes are authorized with a SIWE session checked in the Worker.
- Submit, admin and edit show "coming online soon" until `GET /health` answers, the same as Buy.
- Brand assets: `node scripts/brand.mjs` (logo, favicons, apple-touch-icon, manifest, og-image).

## Worker (worker/)
Endpoints:
- `GET /health`
- Auth: `GET /auth/nonce`, `POST /auth/verify` (EIP-4361, signature verified with viem; nonce in KV, 10-minute TTL; session token TTL taken from the message expiry), `GET /auth/me`
- Media: `POST /media` (images only, at most 2MB and 3000px; the browser re-encodes to WebP; stored in R2 with a content-hash name), `GET /media/:key`
- Collections: `GET /collections`, `GET /collections/:slug`, `GET /collections/:slug/can-edit?address=`, `POST /collections/:slug/update`
- Submissions: `POST /submit`
- Admin: `GET /admin/pending`, `POST /admin/approve/:slug`, `POST /admin/reject/:slug`
- OpenSea proxy: `GET /os/:slug/{items,listings,stats}`
- Buying: `GET /listings/:chain/:contract/:id`, `POST /fulfill`

Admin wallet: `ADMIN_ADDRESSES` in `wrangler.toml` (the LIL FOOTS deployer and `owner()`, 0xca89ae48a5c61d13e78236daa4ac29ee588ea475). It is also the LIL FOOTS editor via `STATIC_EDITORS`.

### Deploy (needs a Cloudflare API token, or `wrangler login`)
Token permissions:
- Account: Workers Scripts Edit, Workers KV Storage Edit, Workers R2 Storage Edit, Account Settings Read
- Zone multisea.io: Workers Routes Edit, DNS Edit

Commands:

    cd worker && npm i
    export CLOUDFLARE_API_TOKEN=...            # or: npx wrangler login
    npx wrangler whoami
    npx wrangler kv namespace create COLLECTIONS   # paste the id into wrangler.toml
    npx wrangler kv namespace create NONCES        # paste the id into wrangler.toml
    npx wrangler r2 bucket create multisea-media   # R2 must be enabled once in the dashboard first (error 10042 otherwise); then uncomment r2_buckets in wrangler.toml and redeploy
    grep -m1 '^OPENSEA_API_KEY=' ../.env | cut -d= -f2- | npx wrangler secret put OPENSEA_API_KEY
    npx wrangler deploy                            # also creates api.multisea.io (custom_domain route)
    curl https://api.multisea.io/health

### Tests (local, Miniflare KV and R2, throwaway keys)

    node -e "..."  # write /tmp/multisea-test-keys.json with two generatePrivateKey() keys (see test/e2e.mjs)
    npx wrangler dev --port 8787 --var ADMIN_ADDRESSES:<test admin> --var 'STATIC_EDITORS:{"lil-foots":["<test admin>"]}'
    node test/e2e.mjs          # 34 API checks
    # UI: VITE_API_BASE=http://localhost:8787 npx vite build --outDir dist-local; npx vite preview --outDir dist-local --port 4174; node scripts/ui-test.mjs
## Custom domain
After the DNS records exist, run `scripts/switch-domain.sh`. It adds the CNAME file, sets the Pages custom domain and rebuilds with base `/`.
