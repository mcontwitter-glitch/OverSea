
## Holder chat + public wallet profiles

No new Cloudflare bindings or secrets are required. Chat messages, five-minute holder-check results, mutes, and profiles use the existing `COLLECTIONS` KV. Existing SIWE sessions use `NONCES`; the existing `MEDIA` R2 binding stores profile images. Chat reads and writes require a valid wallet session and a server-side `balanceOf` gate. Chat-scoped SIWE uses resource `multisea:holders:<slug>`; chat polls every four seconds.

- `GET /holders/:slug/messages?before=<id>` — holder-only page (newest last), 50 messages
- `POST /holders/:slug/messages` — `{ text, name }`, 500-character limit
- `POST /holders/:slug/messages/:id/delete` — existing `ADMIN_ADDRESSES` only
- `POST /holders/:slug/mute` — `{ address, minutes }`, admin only
- `GET /profiles?addresses=0x…,0x…` — public batch, up to 100 addresses
- `POST /profile` — SIWE-authed `{ name, avatar }` or `{ name, nft }`; NFT ownership is checked with `ownerOf` and its image must use the validated `/media/` path

`worker/src/gates.js` mirrors only the server-required gate fields from `config/gates.json`; update both when adding a gated collection. Tests: `node --test test/*.test.mjs`.
