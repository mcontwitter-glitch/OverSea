import test from 'node:test';
import assert from 'node:assert/strict';
import { walletBrowseLink, detectSolflare, isSolMobile } from '../../src/soldetect.ts';

test('Solflare browse universal link encodes the page URL and origin ref', () => {
  const href = 'https://multisea.io/launchpad?x=1&y=2';
  const origin = 'https://multisea.io';
  assert.equal(
    walletBrowseLink('solflare', href, origin),
    `https://solflare.com/ul/v1/browse/${encodeURIComponent(href)}?ref=${encodeURIComponent(origin)}`,
  );
});

test('Phantom browse link stays on phantom.app/ul/browse', () => {
  const href = 'https://multisea.io/', origin = 'https://multisea.io';
  assert.equal(
    walletBrowseLink('phantom', href, origin),
    `https://phantom.app/ul/browse/${encodeURIComponent(href)}?ref=${encodeURIComponent(origin)}`,
  );
});

test('detectSolflare uses window.solflare when isSolflare or connect is present', () => {
  const prov = { isSolflare: true, connect() {} };
  assert.equal(detectSolflare({ solflare: prov }), prov);
  const byConnect = { connect() {} };
  assert.equal(detectSolflare({ solflare: byConnect }), byConnect);
  assert.equal(detectSolflare({ solflare: {} }), undefined);
  assert.equal(detectSolflare({}), undefined);
});

test('detectSolflare falls back to window.solana.isSolflare', () => {
  const solana = { isSolflare: true, connect() {} };
  assert.equal(detectSolflare({ solana }), solana);
  assert.equal(detectSolflare({ solana: { isPhantom: true } }), undefined);
});

test('isSolMobile matches phones and iPad desktop UA', () => {
  assert.equal(isSolMobile('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'), true);
  assert.equal(isSolMobile('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'), true);
  assert.equal(isSolMobile('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', 5), true);
  assert.equal(isSolMobile('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 0), false);
});
