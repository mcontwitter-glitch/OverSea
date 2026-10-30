import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, openSync, fsyncSync, closeSync } from "node:fs";
import { dirname } from "node:path";

export type JobState = "queued" | "built" | "commit_sent" | "reveal_sent" | "confirmed" | "attested" | "released" | "failed" | "closed";
export type Job = {
  orderId: string; collectionId: string; buyer: string; btcAddress: string; deadline: number;
  state: JobState; attempts: number; nextAttemptAt: number; lastError?: string;
  commitHex?: string; commitTxid?: string; revealHex?: string; revealTxid?: string; inscriptionId?: string;
  attestTx?: string; releaseTx?: string; feeRate?: number; updatedAt: number;
};
type State = { lastBlock: string; jobs: Record<string, Job>; reserved: string[] };

/** JSON file store with atomic write (tmp + fsync + rename) -> crash/restart safe, idempotent by orderId. */
export class Store {
  s: State;
  constructor(private path: string, startBlock: bigint) {
    mkdirSync(dirname(path), { recursive: true });
    this.s = existsSync(path) ? JSON.parse(readFileSync(path, "utf8"))
      : { lastBlock: (startBlock - 1n).toString(), jobs: {}, reserved: [] };
  }
  save() {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.s, null, 2));
    const fd = openSync(tmp, "r"); fsyncSync(fd); closeSync(fd);
    renameSync(tmp, this.path);
  }
  get lastBlock() { return BigInt(this.s.lastBlock); }
  setLastBlock(b: bigint) { this.s.lastBlock = b.toString(); this.save(); }
  get(id: bigint | string) { return this.s.jobs[id.toString()]; }
  insertIfAbsent(j: Omit<Job, "updatedAt">) {
    if (this.s.jobs[j.orderId]) return false;
    this.s.jobs[j.orderId] = { ...j, updatedAt: Date.now() }; this.save(); return true;
  }
  update(id: string, patch: Partial<Job>) {
    this.s.jobs[id] = { ...this.s.jobs[id], ...patch, updatedAt: Date.now() }; this.save();
    return this.s.jobs[id];
  }
  reserve(outpoints: string[]) { this.s.reserved = [...new Set([...this.s.reserved, ...outpoints])]; this.save(); }
  isReserved(op: string) { return this.s.reserved.includes(op); }
  active() { return Object.values(this.s.jobs).filter((j) => !["released", "failed", "closed"].includes(j.state)); }
}
