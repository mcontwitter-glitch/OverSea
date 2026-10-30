import { readFileSync } from "node:fs";
import { utf8 } from "@scure/base";

/** Deterministic per-order content. Every attester must render the same bytes (they verify the envelope).
 *  Template placeholders: {{orderId}} {{collectionId}} {{buyer}} — can be a recursive HTML/SVG that
 *  references parent/trait inscriptions via /content/<inscriptionId>. */
export function renderContent(o: { orderId: bigint; collectionId: string; buyer: string }, templateFile?: string): Uint8Array {
  const tpl = templateFile ? readFileSync(templateFile, "utf8") : DEFAULT_SVG;
  const s = tpl.replaceAll("{{orderId}}", o.orderId.toString())
               .replaceAll("{{collectionId}}", o.collectionId.slice(0, 10))
               .replaceAll("{{buyer}}", o.buyer.toLowerCase());
  return utf8.decode(s);
}
const DEFAULT_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#0b3d91"/>` +
  `<text x="50" y="45" font-size="10" text-anchor="middle" fill="#fff">MultiSea</text>` +
  `<text x="50" y="62" font-size="9" text-anchor="middle" fill="#9cf">#{{orderId}} {{collectionId}}</text></svg>`;
