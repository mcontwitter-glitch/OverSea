// Regenerates what /deploy-solana needs from the build outputs (run after `forge build` and `cargo build-sbf`):
//   src/solartifacts.json        creation bytecode of MultiSeaOmniEscrowV2, MultiSeaOmniDropV2, MultiSeaSolanaMover
//   public/sol/multisea_omni.so  the Solana program file the page deploys (+ its sha256 / size in solartifacts.json)
//   config/launchpad.json        solana.v2: the CREATE2 addresses of the new contracts on every chain (deterministic: the same
//                                bytecode + arguments always give the same address, whoever sends the deploy and whenever)
import fs from 'node:fs';
import crypto from 'node:crypto';
import { encodeDeployData, getAddress, getContractAddress, keccak256, toHex } from 'viem';
const LPF = 'config/launchpad.json'; const LP = JSON.parse(fs.readFileSync(LPF, 'utf8'));
const art = n => { const j = JSON.parse(fs.readFileSync(`contracts/out/${n}.sol/${n}.json`, 'utf8')); return { abi: j.abi, bytecode: j.bytecode.object }; };
const ES = art('MultiSeaOmniEscrowV2'), OD = art('MultiSeaOmniDropV2'), MV = art('MultiSeaSolanaMover');
const so = fs.readFileSync('solana/target/deploy/multisea_omni.so');
fs.copyFileSync('solana/target/deploy/multisea_omni.so', 'public/sol/multisea_omni.so');
const DEPLOYER = '0x4e59b44847b379578588920ca78fbf26c0b4956c'; // deterministic deployment proxy (CREATE2), live on all 5 chains
const SALT = keccak256(toHex('multisea-solana-v1'));
const M = LP.mainnet; const OWNER = getAddress(M.deployer); const FEE = getAddress(M.feeWallet); const SOL_EID = LP.solana.eid;
const c2 = init => getContractAddress({ opcode: 'CREATE2', from: DEPLOYER, salt: SALT, bytecode: init });
const v2 = { deployer: DEPLOYER, salt: SALT, owner: OWNER, escrows: {}, dropImpls: {}, movers: {} };
for (const [k, c] of Object.entries(M.chains)) {
  v2.escrows[k] = c2(encodeDeployData({ abi: ES.abi, bytecode: ES.bytecode, args: [c.endpoint, OWNER, FEE, BigInt(c.moveFeeWei)] }));
  v2.dropImpls[k] = c2(OD.bytecode);
  v2.movers[k] = c2(encodeDeployData({ abi: MV.abi, bytecode: MV.bytecode, args: [c.endpoint, OWNER, getAddress(c.omniEscrow), SOL_EID] }));
}
LP.solana.v2 = v2; fs.writeFileSync(LPF, JSON.stringify(LP, null, 2) + '\n');
fs.writeFileSync('src/solartifacts.json', JSON.stringify({ escrowV2: ES.bytecode, dropV2: OD.bytecode, mover: MV.bytecode,
  so: { path: '/sol/multisea_omni.so', size: so.length, sha256: crypto.createHash('sha256').update(so).digest('hex') } }) + '\n');
console.log(JSON.stringify(v2, null, 1), '\nso', so.length);
