import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const TOKEN_TTL_MS = 5 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;

interface TokenRecord {
  cartId: string;
  quoteHash: string;
  expiresAt: number;
  used: boolean;
}

interface Pending {
  id: string;
  secret: string;
  cartId: string;
  quoteId: string;
  quoteHash: string;
  title: string;
  body: string;
  status: "waiting" | "confirmed" | "declined";
  createdAt: number;
}

export type TokenCheck = { ok: true } | { ok: false; reason: string };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Issues one-time order tokens, and only after the *user* (not the model) has
 * said yes. The yes comes through a channel the model can't write to: the MCP
 * client's own confirmation dialog (elicitation), or a page on 127.0.0.1 that
 * the user opens and clicks.
 *
 * Tokens are random, single-use, expire in 5 minutes, and are bound to one cart
 * and one quote hash, so any change to the cart, price or tip invalidates them.
 * Nothing here is written to disk.
 */
export class ConfirmationService {
  private tokens = new Map<string, TokenRecord>();
  private pending = new Map<string, Pending>();
  private server?: Server;
  private port?: number;

  constructor(private now: () => number = Date.now) {}

  /** Call only after the user has confirmed out-of-band. */
  mintToken(cartId: string, quoteHash: string): { token: string; expires_at: string } {
    const token = randomBytes(24).toString("base64url");
    const expiresAt = this.now() + TOKEN_TTL_MS;
    this.tokens.set(token, { cartId, quoteHash, expiresAt, used: false });
    return { token, expires_at: new Date(expiresAt).toISOString() };
  }

  /** Checks a token and burns it. A token works at most once, even if the check fails on the hash. */
  consumeToken(token: string, cartId: string, currentQuoteHash: string): TokenCheck {
    const rec = this.tokens.get(token);
    if (!rec) return { ok: false, reason: "Unknown confirmation token." };
    if (rec.used) return { ok: false, reason: "This confirmation token was already used." };
    rec.used = true;
    if (this.now() > rec.expiresAt) return { ok: false, reason: "The confirmation expired (tokens last 5 minutes). Show the total again and re-confirm." };
    if (rec.cartId !== cartId) return { ok: false, reason: "This confirmation was for a different cart." };
    if (rec.quoteHash !== currentQuoteHash) return { ok: false, reason: "The cart or its total changed after the user confirmed. Show the new total and re-confirm." };
    return { ok: true };
  }

  /** Fallback for MCP clients without a confirmation dialog: a local page the user clicks. */
  async createLocalConfirmation(args: { cartId: string; quoteId: string; quoteHash: string; title: string; body: string }): Promise<{ id: string; url: string }> {
    await this.ensureServer();
    const id = randomBytes(8).toString("hex");
    const secret = randomBytes(16).toString("hex");
    this.pending.set(id, { id, secret, ...args, status: "waiting", createdAt: this.now() });
    return { id, url: `http://127.0.0.1:${this.port}/confirm/${id}` };
  }

  findPending(quoteId: string): Pending | undefined {
    for (const p of this.pending.values()) {
      if (p.quoteId === quoteId && this.now() - p.createdAt < PENDING_TTL_MS) return p;
    }
    return undefined;
  }

  pendingUrl(p: Pending): string {
    return `http://127.0.0.1:${this.port}/confirm/${p.id}`;
  }

  clearPending(id: string): void {
    this.pending.delete(id);
  }

  private async ensureServer(): Promise<void> {
    if (this.server) return;
    const server = createServer((req, res) => {
      const m = /^\/confirm\/([0-9a-f]+)$/.exec(req.url ?? "");
      const p = m ? this.pending.get(m[1]!) : undefined;
      // Only this machine's browser may talk to us: rejects DNS-rebinding and cross-site requests.
      const hostOk = req.headers.host === `127.0.0.1:${this.port}`;
      if (!p || !hostOk || this.now() - p.createdAt > PENDING_TTL_MS) {
        res.writeHead(404, { "content-type": "text/plain" }).end("Not found or expired.");
        return;
      }
      const page = (inner: string) =>
        res
          .writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'" })
          .end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Confirm order</title>
<style>body{font:16px system-ui;max-width:34rem;margin:3rem auto;padding:0 1rem}pre{background:#f4f4f4;color:#111;padding:1rem;border-radius:8px;overflow:auto}button{font:inherit;padding:.6rem 1.2rem;border-radius:8px;border:1px solid #888;cursor:pointer;margin-right:.5rem}.yes{background:#0a7d32;color:#fff;border-color:#0a7d32}</style>
${inner}`);

      if (req.method === "GET") {
        if (p.status !== "waiting") return void page(`<h1>${p.status === "confirmed" ? "Confirmed" : "Declined"}</h1><p>You can close this tab and go back to your assistant.</p>`);
        return void page(`<h1>${esc(p.title)}</h1><pre>${esc(p.body)}</pre>
<p>Nothing is ordered unless you confirm here.</p>
<form method="post"><input type="hidden" name="k" value="${p.secret}">
<button class="yes" name="answer" value="yes">Yes, confirm this total</button><button name="answer" value="no">No, cancel</button></form>`);
      }
      if (req.method === "POST") {
        let body = "";
        req.on("data", (c: Buffer) => {
          body += c.toString();
          if (body.length > 2000) req.destroy();
        });
        req.on("end", () => {
          const form = new URLSearchParams(body);
          const k = Buffer.from(form.get("k") ?? "");
          const good = k.length === p.secret.length && timingSafeEqual(k, Buffer.from(p.secret));
          const origin = req.headers.origin;
          if (!good || (origin && origin !== `http://127.0.0.1:${this.port}`)) {
            res.writeHead(403, { "content-type": "text/plain" }).end("Forbidden.");
            return;
          }
          if (p.status === "waiting") p.status = form.get("answer") === "yes" ? "confirmed" : "declined";
          page(`<h1>${p.status === "confirmed" ? "Confirmed" : "Declined"}</h1><p>You can close this tab and go back to your assistant.</p>`);
        });
        return;
      }
      res.writeHead(405).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    server.unref();
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = undefined;
  }
}
