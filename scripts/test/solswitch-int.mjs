// Integration test of the Worker's "Turn Solana on" check (worker/src/solswitch.js) against REAL state: the program deployed
// + set up on the local validator by solprog-local.ts, and a Base mainnet fork walked through all its steps by solplan-fork.ts.
// Other chains are read from mainnet (not set up there yet), so they must be the only problems reported.
// Usage: node scripts/test/solswitch-int.mjs <programId> <base fork rpc>
import fs from 'node:fs';
import { verifySolanaSetup } from '../../worker/src/solswitch.js';
const LP = JSON.parse(fs.readFileSync(new URL('../../config/launchpad.json', import.meta.url)));
const CFG = JSON.parse(fs.readFileSync(new URL('../../config/collections.json', import.meta.url)));
const [pid, fork] = process.argv.slice(2);
let fails = 0; const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); };
const rpcOf = k => (k === 'base' ? fork : CFG.chains[k].rpc);
const r = await verifySolanaSetup({ programId: pid, LP, chains: CFG.chains, solRpc: 'http://127.0.0.1:8899', rpcOf });
console.log(r.problems.map(p => '   - ' + p).join('\n'));
ok(!r.problems.some(p => p.startsWith('Solana')), 'Solana program, settings and all 5 links verified on the validator');
ok(!r.problems.some(p => p.startsWith('base')), 'Base (fork, all steps signed): factory -> V2 escrow, escrow peer = Store PDA, isSolana');
ok(['ethereum', 'apechain', 'bnb', 'robinhood'].every(k => r.problems.some(p => p.startsWith(k))) && !r.ok, 'chains not set up are reported and the switch is refused');
const r2 = await verifySolanaSetup({ programId: 'Abu55rcZKUwUvuMDbpNrHy28RF9A8PBasZa5BGGNWiA7', LP, chains: CFG.chains, solRpc: 'http://127.0.0.1:8899', rpcOf: () => fork });
ok(!r2.ok && r2.problems.includes('Solana: the program is not deployed') && r2.problems.some(p => /base: escrow not linked/.test(p)), 'a different program id fails on Solana and on the EVM peer check');
const LP2 = { ...LP, solana: { ...LP.solana, feeRecipient: '11111111111111111111111111111111' } };
const r3 = await verifySolanaSetup({ programId: pid, LP: LP2, chains: CFG.chains, solRpc: 'http://127.0.0.1:8899', rpcOf });
ok(r3.problems.includes('Solana: settings have the wrong fee recipient'), 'wrong fee recipient in the settings is caught');
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
