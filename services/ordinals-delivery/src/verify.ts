import { hex } from "@scure/base";
import type { BtcBackend } from "./btc/backend.js";
import { decodeReveal, type Net } from "./btc/inscribe.js";
import { renderContent } from "./content.js";

/** Independent check an attester runs before signing: reveal tx is buried >= minConfs, output 0 pays the
 *  order's btcAddress, and the envelope decodes to exactly the expected content. */
export async function verifyDelivery(p: {
  btc: BtcBackend; net: Net; minConfs: number; revealTxid: string; inscriptionId: string;
  order: { orderId: bigint; collectionId: string; buyer: string; btcAddress: string };
  contentType: string; template?: string;
}) {
  if (p.inscriptionId !== `${p.revealTxid}i0`) throw new Error("inscriptionId must be <revealTxid>i0");
  const t = await p.btc.tx(p.revealTxid);
  if (!t) throw new Error("reveal tx not found");
  if (t.confirmations < p.minConfs) throw new Error(`only ${t.confirmations}/${p.minConfs} confirmations`);
  const d = decodeReveal(t.hex, p.net);
  if (d.txid !== p.revealTxid) throw new Error("txid mismatch");
  if (d.dest !== p.order.btcAddress) throw new Error(`reveal pays ${d.dest}, order wants ${p.order.btcAddress}`);
  const expected = renderContent(p.order, p.template);
  const ins = d.inscriptions[0];
  if (ins.tags.contentType !== p.contentType) throw new Error("content type mismatch");
  if (hex.encode(ins.body) !== hex.encode(expected)) throw new Error("inscription body mismatch");
  return true;
}
