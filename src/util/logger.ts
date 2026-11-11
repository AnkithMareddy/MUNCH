/**
 * Structured logs to stderr (stdout belongs to the MCP protocol).
 * Logs must never contain personal data: we log what happened, not what was said.
 * As a second line of defense, anything logged is redacted by key name and pattern.
 */
const SENSITIVE_KEYS = /address|email|phone|name|token|cookie|password|secret|authorization|lat|lng|query|notes|card/i;
const PATTERNS: [RegExp, string][] = [
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]"],
  [/(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, "[phone]"],
  [/\b\d{1,6}\s+[A-Za-z0-9.' ]{2,40}\s(street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|way|place|pl|court|ct)\b\.?/gi, "[address]"],
  [/\b(?:\d[ -]?){13,19}\b/g, "[number]"],
];

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[deep]";
  if (typeof value === "string") return PATTERNS.reduce((s, [re, rep]) => s.replace(re, rep), value);
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE_KEYS.test(k) ? "[redacted]" : redact(v, depth + 1);
    return out;
  }
  return value;
}

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export function createLogger(write: (line: string) => void = (l) => process.stderr.write(l + "\n")): Logger {
  const quiet = process.env.MUNCH_LOG === "silent";
  const emit = (level: string, event: string, fields?: Record<string, unknown>) => {
    if (quiet) return;
    write(JSON.stringify({ t: new Date().toISOString(), level, event, ...(redact(fields ?? {}) as object) }));
  };
  return { info: (e, f) => emit("info", e, f), warn: (e, f) => emit("warn", e, f), error: (e, f) => emit("error", e, f) };
}
