import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createContext, type AppContext, type Config } from "../src/context.js";
import { createServer } from "../src/server.js";
import { StaticKeyProvider } from "../src/storage/keys.js";

export interface Rig {
  ctx: AppContext;
  client: Client;
  /** Calls a tool and parses the JSON part of its text result. */
  call: (name: string, args?: Record<string, unknown>) => Promise<{ data: any; text: string; isError: boolean }>;
  elicitations: string[];
}

/** A server and a client wired together in-process. `answer` is what the "user" says to confirmation dialogs. */
export async function rig(opts: { config?: Partial<Config>; elicitation?: boolean; answer?: boolean } = {}): Promise<Rig> {
  const ctx = createContext({ dataDir: mkdtempSync(join(tmpdir(), "munch-test-")), keys: new StaticKeyProvider(), log: { info() {}, warn() {}, error() {} }, enableMock: true, enablePlaceOrder: false, ...opts.config });
  const server = createServer(ctx);
  const elicitations: string[] = [];
  const client = new Client({ name: "test", version: "0" }, { capabilities: opts.elicitation === false ? {} : { elicitation: {} } });
  if (opts.elicitation !== false) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      elicitations.push(req.params.message);
      return opts.answer === false ? { action: "decline" } : { action: "accept", content: { confirm: true } };
    });
  }
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call: Rig["call"] = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
    const start = text.search(/^[{[]/m);
    let data: any;
    try {
      data = JSON.parse(text.slice(start));
    } catch {
      data = undefined;
    }
    return { data, text, isError: res.isError === true };
  };
  return { ctx, client, call, elicitations };
}
