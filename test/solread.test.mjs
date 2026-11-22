// Browser Solana read hedge: Worker JSON-RPC error / timeout falls back to publicnode.
import test from 'node:test';
import assert from 'node:assert/strict';
import { firstGoodSolRead } from '../src/solreadfetch.ts';

const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const stub = plan => async (u) => {
  const p = plan[u]; p.calls = (p.calls || 0) + 1;
  await sleep(p.ms || 0);
  if (p.err) throw new Error(p.err);
  return json(p.res, p.status || 200);
};

test('firstGoodSolRead returns a fast second URL when the Worker is slow or returns a JSON-RPC error', async () => {
  const plan = {
    worker: { ms: 2000, res: { jsonrpc: '2.0', id: 1, result: 'late' } },
    public: { ms: 20, res: { jsonrpc: '2.0', id: 1, result: { value: [null] } } },
  };
  const t = Date.now();
  const r = await firstGoodSolRead(['worker', 'public'], { body: '{}' }, 50, stub(plan));
  const j = await r.json();
  assert.equal(j.result.value[0], null);
  assert.ok(Date.now() - t < 500, 'hedged to publicnode');
  assert.ok(plan.public.calls >= 1);
});

test('firstGoodSolRead treats HTTP 200 + error (Worker timeout body) as a failure and uses the next URL', async () => {
  const plan = {
    worker: { ms: 10, res: { jsonrpc: '2.0', id: 'abc', error: { code: -32603, message: 'https://solana-rpc.publicnode.com timeout' } } },
    public: { ms: 10, res: { jsonrpc: '2.0', id: 'abc', result: 'ok' } },
  };
  const r = await firstGoodSolRead(['worker', 'public'], { body: '{}' }, 500, stub(plan));
  assert.equal((await r.json()).result, 'ok');
  assert.equal(plan.worker.calls, 1);
  assert.equal(plan.public.calls, 1);
});

test('firstGoodSolRead rejects when every URL fails', async () => {
  const plan = { a: { ms: 5, status: 500, res: { error: 'internal' } }, b: { ms: 5, res: { error: { code: -32603, message: 'x' } } } };
  await assert.rejects(firstGoodSolRead(['a', 'b'], {}, 20, stub(plan)));
});
