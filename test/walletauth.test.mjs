import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = await mkdtemp(join(tmpdir(), 'walletauth-'));
try {
  execFileSync('npx', ['tsc', 'src/walletauth.ts', '--outDir', out, '--target', 'es2022', '--module', 'esnext', '--moduleResolution', 'bundler', '--lib', 'es2022,dom', '--skipLibCheck', '--ignoreConfig'], { stdio: 'pipe' });
  await rename(join(out, 'walletauth.js'), join(out, 'walletauth.mjs'));
  const { unauthorized, authHint, unlockAccount, switchOrAddChain, chainIdOf } = await import(join(out, 'walletauth.mjs'));

  // Island #93 holder EOA (ownerOf on Robinhood) vs its token wallets — claim must use the EOA.
  const HOLDER = '0x5d72bc99d5c04B7598C7D3Abc982fA2648010d76';
  const TBA_RH = '0xCDE10DEdD289e1a16915f2F25f69E91Bd7C86BE2';
  const ROBINHOOD = { chainId: 4663, name: 'Robinhood', native: 'ETH', rpc: 'https://rpc.mainnet.chain.robinhood.com', explorer: 'https://robinhoodchain.blockscout.com' };

  assert.equal(unauthorized({ code: 4100, message: 'The requested method and/or account has not been authorized by the user.' }), true);
  assert.equal(unauthorized({ cause: { code: 4100, message: 'The requested method and/or account has not been authorized by the user.' } }), true);
  assert.equal(unauthorized({ code: 4001, message: 'User rejected the request.' }), false);
  assert.equal(authHint('Robinhood'), 'Approve this site for your wallet account and Robinhood network, then try again');
  assert.equal(chainIdOf('0x1237'), 4663);

  const err4100 = (method) => Object.assign(new Error('The requested method and/or account has not been authorized by the user.'), { code: 4100, method });

  // Mock: account/chain start unauthorized. 4100 until permissions + add-chain. Signing as the TBA is 4100; the EOA is allowed.
  function mock({ authorized = false, chains = new Set([8453]), selected = HOLDER } = {}) {
    const log = [];
    let allowed = authorized;
    const chainIds = new Set(chains);
    let current = [...chainIds][0] || 8453;
    const provider = {
      async request({ method, params }) {
        log.push(method);
        if (method === 'eth_chainId') {
          if (!allowed && current === 4663) throw err4100(method);
          return '0x' + current.toString(16);
        }
        if (method === 'eth_requestAccounts') {
          if (!allowed) throw err4100(method);
          return [selected];
        }
        if (method === 'wallet_requestPermissions') { allowed = true; return [{ parentCapability: 'eth_accounts' }]; }
        if (method === 'wallet_switchEthereumChain') {
          const id = parseInt(params[0].chainId, 16);
          if (!chainIds.has(id)) throw Object.assign(new Error('Unrecognized chain'), { code: 4902 });
          if (!allowed) throw err4100(method);
          current = id; return null;
        }
        if (method === 'wallet_addEthereumChain') {
          if (!allowed) throw err4100(method);
          const id = parseInt(params[0].chainId, 16);
          chainIds.add(id); current = id; return null;
        }
        if (method === 'eth_sendTransaction') {
          const from = String(params[0].from || '');
          if (!allowed) throw err4100(method);
          if (from.toLowerCase() !== selected.toLowerCase()) throw err4100(method);
          return '0xabc';
        }
        throw new Error('unexpected ' + method);
      },
    };
    return { provider, log, get current() { return current; } };
  }

  // 1) First accounts request is 4100; permissions then unlocks the holder EOA (not the TBA).
  {
    const m = mock({ authorized: false, chains: new Set([8453]), selected: HOLDER });
    const addr = await unlockAccount(m.provider);
    assert.equal(addr, HOLDER);
    assert.ok(m.log.includes('wallet_requestPermissions'));
    assert.notEqual(addr.toLowerCase(), TBA_RH.toLowerCase());
  }

  // 2) Switch to Robinhood when the chain is missing + unauthorized: add, then end on 4663.
  {
    const m = mock({ authorized: true, chains: new Set([8453]), selected: HOLDER });
    await switchOrAddChain(m.provider, ROBINHOOD);
    assert.equal(m.current, 4663);
    assert.ok(m.log.includes('wallet_addEthereumChain'));
  }

  // 3) 4100 on switch (chain listed but not authorized) also goes through add after permissions in add path.
  {
    const m = mock({ authorized: false, chains: new Set([8453]), selected: HOLDER });
    // unlock first as the claim path does
    await unlockAccount(m.provider);
    await switchOrAddChain(m.provider, ROBINHOOD);
    assert.equal(m.current, 4663);
  }

  // 4) Sending from the token wallet is 4100; sending from the holder EOA is allowed.
  {
    const m = mock({ authorized: true, chains: new Set([4663]), selected: HOLDER });
    await assert.rejects(
      () => m.provider.request({ method: 'eth_sendTransaction', params: [{ from: TBA_RH, to: '0x64668360270e6a78483a59ba5154e8782b363a70' }] }),
      e => e.code === 4100,
    );
    const hash = await m.provider.request({ method: 'eth_sendTransaction', params: [{ from: HOLDER, to: '0x64668360270e6a78483a59ba5154e8782b363a70' }] });
    assert.equal(hash, '0xabc');
  }

  console.log('PASS walletauth: 4100 unlock + add Robinhood; #93 holder EOA can send, token wallet cannot');
} finally {
  await rm(out, { recursive: true, force: true });
}
