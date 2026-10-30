import { loadDotEnv, loadConfig, secret } from "./config.js";
import { createService, startAttesterServer } from "./service.js";
import { serviceWallet } from "./btc/inscribe.js";
import { btcNet } from "./btc/networks.js";
import { hex } from "@scure/base";
import { log } from "./log.js";

loadDotEnv(process.env.DOTENV ?? ".env");
const cmd = process.argv[2] ?? "run";
const c = loadConfig();
if (cmd === "address") {
  // prints only the PUBLIC funding address
  console.log(serviceWallet(hex.decode(secret("BTC_SERVICE_PRIVKEY")!.replace(/^0x/, "")), btcNet(c.btc.network)).address);
} else if (cmd === "attester") {
  await startAttesterServer(c);
} else if (cmd === "once") {
  const s = await createService(c); await s.tick();
} else {
  const s = await createService(c);
  const ac = new AbortController();
  process.on("SIGINT", () => { log.info("shutting down"); ac.abort(); });
  process.on("SIGTERM", () => ac.abort());
  await s.run(ac.signal);
}
