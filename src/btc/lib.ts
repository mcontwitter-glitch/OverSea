// Lazily-loaded Bitcoin core (bitcoinjs-lib + @bitcoinerlab/secp256k1, pure JS). Pages import this only when a PSBT/BIP-322 op is needed.
import './polyfill';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from '@bitcoinerlab/secp256k1';
import { makeBtc } from './psbtcore.js';
export const B = makeBtc(bitcoin, ecc);
export { bitcoin };
