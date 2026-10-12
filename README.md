# Multichain collection dashboard (OpenSea-style)
Static Vite + TypeScript site. Collections and chains live in `config/collections.json`. To add a collection, append it to `collections` with its `deployments` and `escrow`, then run `npm run data -- <slug>` and open `?c=<slug>`.

    npm i
    npm run data          # node --env-file=.env scripts/index.mjs  -> public/data/<slug>/
    #   flags: --skip-meta  --skip-chain  --chains=ethereum,robinhood
    npm run build         # dist/ is a static site (base '/OverSea/' for GitHub Pages)
    npx vite preview      # http://localhost:4173
    node scripts/screens.mjs   # screenshots (needs preview running)

`.env` holds OPENSEA_API_KEY. It's gitignored and only read by the Node pipeline, never bundled. Without the key, volume falls back to on-chain Seaport 1.6 OrderFulfilled sales, and listings and floor show "needs OpenSea API key".
