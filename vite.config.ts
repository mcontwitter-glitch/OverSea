import { defineConfig } from 'vite';
// base './' so the static build works from any GitHub Pages subpath.
// Only VITE_* env vars are exposed to the client; OPENSEA_API_KEY stays server-side (pipeline only).
export default defineConfig({ base: process.env.VITE_BASE || '/', build: { target: 'es2022' } });
