// Minimal JSON-lines logger. Redacts anything that looks like a secret.
const SECRET_KEYS = /key|secret|wif|mnemonic|seed|password|private/i;
function redact(v: unknown): unknown {
  if (v instanceof Error) return { message: v.message, stack: v.stack?.split("\n").slice(0, 4).join(" | ") };
  if (typeof v === "bigint") return v.toString();
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = SECRET_KEYS.test(k) ? "[redacted]" : redact(x);
    return o;
  }
  return v;
}
function emit(level: string, msg: string, data?: Record<string, unknown>) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...(redact(data ?? {}) as object) });
  (level === "error" || level === "warn" ? console.error : console.log)(line);
}
export const log = {
  info: (m: string, d?: Record<string, unknown>) => emit("info", m, d),
  warn: (m: string, d?: Record<string, unknown>) => emit("warn", m, d),
  error: (m: string, d?: Record<string, unknown>) => emit("error", m, d),
  debug: (m: string, d?: Record<string, unknown>) => { if (process.env.LOG_LEVEL === "debug") emit("debug", m, d); },
};
