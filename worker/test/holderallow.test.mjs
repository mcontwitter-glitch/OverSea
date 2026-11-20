// Unit tests for holder allowlist qualifying + mixed EVM/Solana Merkle leaves.
// Run: node --test test/holderallow.test.mjs test/launchpad.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, concat, toHex } from 'viem';
import { qualifyFromSources, parseSources, isSolAddr } from '../src/holderallow.js';
import { merkle, proofFor, leafOf, isEvmAddr } from '../src/launchpad.js';
import { solKey } from '../src/solanadrop.js';

const A = '0x00000000000000000000000000000000000000a1';
const B = '0x00000000000000000000000000000000000000b2';
const C = '0x00000000000000000000000000000000000000c3';
const ESC = '0x6cb09c1fca57540607f08273c9cd6335287374ad';
const SOL = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SOL2 = 'So11111111111111111111111111111111111111112';

test('parseSources accepts MultiSea slugs, EVM contracts, and Solana collection addresses', () => {
  const bad = (m) => { throw new Error(m); };
  const ADDR = /^0x[0-9a-fA-F]{40}$/;
  const s = parseSources([
    { slug: 'multi-islands', min: 1 },
    { chain: 'ethereum', address: '0x059EDD72Cd353dF5106D2B9cC5ab83a52287aC3a', min: 2 },
    { chain: 'solana', address: SOL, min: 1 },
  ], { bad, ADDR });
  assert.equal(s[0].slug, 'multi-islands');
  assert.equal(s[1].address, '0x059edd72cd353df5106d2b9cc5ab83a52287ac3a');
  assert.equal(s[2].chain, 'solana');
  assert.ok(isSolAddr(SOL));
  assert.throws(() => parseSources([{ chain: 'abstract', address: A, min: 1 }], { bad, ADDR }), /Base, Ethereum/);
});

test('union of two collections, min held, escrow excluded', () => {
  const r = qualifyFromSources([
    { min: 1, tokens: [{ owner: A, id: 1 }, { owner: B, id: 2 }, { owner: ESC, id: 3 }] },
    { min: 2, tokens: [{ owner: C, id: 1 }, { owner: C, id: 2 }, { owner: B, id: 9 }] },
  ], { exclude: new Set([ESC]) });
  // A qualifies from source 1; B qualifies from both (src2 only has 1 token so B only via src1); C qualifies from src2 (2 tokens)
  assert.deepEqual(r.addresses, [A, B, C].sort());
  assert.equal(r.excludedEscrow, 1);
  assert.equal(r.skippedSolana, 0);
});

test('min held is unique tokens per MultiSea profile (linked wallets share a count)', () => {
  const profiles = new Map();
  const rec = { primary: A, wallets: [{ addr: B, kind: 'evm' }] };
  profiles.set(A, rec); profiles.set(B, rec);
  const r = qualifyFromSources([
    { min: 2, tokens: [{ owner: A, id: 1 }, { owner: B, id: 2 }] },
  ], { profiles, includeLinked: true });
  assert.ok(r.addresses.includes(A) && r.addresses.includes(B));
  const one = qualifyFromSources([
    { min: 2, tokens: [{ owner: A, id: 1 }] },
  ], { profiles, includeLinked: true });
  assert.equal(one.addresses.length, 0);
});

test('includeLinked off maps a Solana holder to the primary EVM only', () => {
  const rec = { primary: A, wallets: [{ addr: SOL, kind: 'sol' }, { addr: B, kind: 'evm' }] };
  const profiles = new Map([[SOL, rec], [A, rec], [B, rec]]);
  const off = qualifyFromSources([{ min: 1, tokens: [{ owner: SOL, id: 1 }] }], { profiles, includeLinked: false, includeSolana: false });
  assert.deepEqual(off.addresses, [A]);
  const on = qualifyFromSources([{ min: 1, tokens: [{ owner: SOL, id: 1 }] }], { profiles, includeLinked: true, includeSolana: false });
  assert.deepEqual(on.addresses.sort(), [A, B].sort());
});

test('Solana-only holders are skipped on EVM-only drops and included when the drop has Solana', () => {
  const skip = qualifyFromSources([{ min: 1, tokens: [{ owner: SOL, id: 1 }, { owner: A, id: 2 }] }], { includeSolana: false });
  assert.deepEqual(skip.addresses, [A]);
  assert.equal(skip.skippedSolana, 1);
  const inc = qualifyFromSources([{ min: 1, tokens: [{ owner: SOL, id: 1 }, { owner: A, id: 2 }] }], { includeSolana: true });
  assert.deepEqual(inc.addresses.sort(), [A, SOL].sort());
  assert.equal(inc.skippedSolana, 0);
  assert.equal(inc.solana, 1);
});

test('worker cap truncates and warns', () => {
  const tokens = Array.from({ length: 15 }, (_, i) => ({ owner: '0x' + (i + 1).toString(16).padStart(40, '0'), id: i + 1 }));
  const r = qualifyFromSources([{ min: 1, tokens }], { cap: 10 });
  assert.equal(r.count, 10);
  assert.equal(r.truncated, true);
  assert.match(r.warning, /10/);
});

test('EVM-only merkle root is unchanged (still OZ sorted-pair, abi.encode leaves)', () => {
  const AL = [A, B, C];
  const { root, layers } = merkle(AL);
  for (const a of AL) {
    let h = leafOf(a);
    for (const s of proofFor(layers, a)) h = keccak256(h < s ? concat([h, s]) : concat([s, h]));
    assert.equal(h, root);
  }
  assert.equal(proofFor(layers, '0x00000000000000000000000000000000000000d4'), null);
  // Same list in mixed case still matches the lowercased tree
  assert.equal(merkle(AL.map(a => a.toUpperCase().replace('0X', '0x'))).root, root);
});

test('mixed EVM + Solana leaves share one root; each proof verifies; Solana keys are case-sensitive', () => {
  assert.ok(isSolAddr(SOL) && !isEvmAddr(SOL));
  const inner = keccak256(toHex(solKey(SOL)));
  assert.equal(leafOf(SOL), keccak256(inner));
  const addrs = [A, SOL, B];
  const { root, layers } = merkle(addrs);
  for (const a of addrs) {
    const pr = proofFor(layers, a);
    assert.ok(pr, 'proof for ' + a);
    let h = leafOf(a);
    for (const s of pr) h = keccak256(h < s ? concat([h, s]) : concat([s, h]));
    assert.equal(h, root);
  }
  // A different casing of the Solana key is a different (invalid) address — must not lowercase it
  const flipped = SOL.slice(0, 8) + SOL.slice(8).toLowerCase();
  if (flipped !== SOL) assert.equal(proofFor(layers, flipped), null);
});
