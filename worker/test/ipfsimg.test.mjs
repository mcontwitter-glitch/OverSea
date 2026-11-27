import { ipfsPath, publicImage, GATEWAYS, makeIpfsImg } from '../src/ipfsimg.js';
import assert from 'node:assert/strict';

const cid = 'bafybeihnbmzlng7gaximwptjp5fqyr2wrzbautbchzontiqu6z3pr26agu';
assert.equal(ipfsPath('ipfs://' + cid), cid);
assert.equal(ipfsPath('https://ipfs.filebase.io/ipfs/' + cid), cid);
assert.equal(ipfsPath('https://gateway.pinata.cloud/ipfs/' + cid), cid);
assert.equal(ipfsPath('https://i2c.seadn.io/foo.png'), '');
assert.equal(ipfsPath(''), '');
assert.equal(publicImage('ipfs://' + cid), 'https://api.multisea.io/img/ipfs/' + cid);
assert.equal(publicImage('https://ipfs.filebase.io/ipfs/' + cid), 'https://api.multisea.io/img/ipfs/' + cid);
assert.equal(publicImage('https://i2c.seadn.io/foo.png'), 'https://i2c.seadn.io/foo.png');
assert.equal(publicImage(''), '');
assert.equal(publicImage('  '), '');

const { fetchFromGateways } = makeIpfsImg();
const r = await fetchFromGateways(cid);
assert.equal(r.ok, true);
const t = r.headers.get('content-type');
assert.match(t, /^image\//);
const buf = Buffer.from(await r.arrayBuffer());
assert.ok(buf.length > 1000);
assert.equal(buf[0], 0x89); // PNG
console.log('ok', GATEWAYS.length, 'gateways, fetched', buf.length, 'bytes', t);
