// SPA fallback for GitHub Pages: serve the app for /c/<slug>, /submit, /admin.
import fs from 'node:fs'; fs.copyFileSync('dist/index.html', 'dist/404.html');
for (const p of ['submit', 'admin']) { fs.mkdirSync(`dist/${p}`, { recursive: true }); fs.copyFileSync('dist/index.html', `dist/${p}/index.html`); }
fs.mkdirSync('dist/c/lil-foots', { recursive: true }); fs.copyFileSync('dist/index.html', 'dist/c/lil-foots/index.html');
fs.writeFileSync('dist/.nojekyll', ''); console.log('postbuild: 404.html + route copies');
