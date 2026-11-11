/**
 * Chat with Food Concierge from the terminal, using either LLM against the
 * same MCP server. This is the proof that the server is model-agnostic.
 *
 *   ANTHROPIC_API_KEY=... npm run harness:claude
 *   OPENAI_API_KEY=...    npm run harness:openai
 *
 * Type your messages; Ctrl-D to quit. Set MODEL to override the model.
 */
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";
import type { AgentInputItem } from "@openai/agents";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = { command: "npx", args: ["tsx", join(root, "src/index.ts")] };
const llm = process.argv[process.argv.indexOf("--llm") + 1];
const rl = createInterface({ input: process.stdin });
// Lines are queued so piped input works as well as typing.
const queue: string[] = [];
const waiters: ((line: string | undefined) => void)[] = [];
let closed = false;
rl.on("line", (line) => (waiters.length ? waiters.shift()!(line) : queue.push(line)));
rl.on("close", () => {
  closed = true;
  for (const w of waiters.splice(0)) w(undefined);
});
const ask = (q: string): Promise<string | undefined> => {
  process.stdout.write(q);
  if (queue.length) return Promise.resolve(queue.shift());
  if (closed) return Promise.resolve(undefined);
  return new Promise((resolve) => waiters.push(resolve));
};

async function claude(): Promise<void> {
  const { default: AnthropicClient } = await import("@anthropic-ai/sdk");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const { ElicitRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");

  const mcp = new Client({ name: "munch-claude-harness", version: "0" }, { capabilities: { elicitation: {} } });
  // Confirmation prompts go straight to the person at the keyboard, never through the model.
  mcp.setRequestHandler(ElicitRequestSchema, async (req) => {
    console.log(`\n=== CONFIRMATION REQUIRED ===\n${req.params.message}`);
    const a = (await ask("Type yes to confirm, anything else to cancel: ")) ?? "";
    return /^y(es)?$/i.test(a.trim()) ? { action: "accept", content: { confirm: true } } : { action: "decline" };
  });
  await mcp.connect(new StdioClientTransport({ ...SERVER, env: { ...(process.env as Record<string, string>), MUNCH_LOG: "silent" } }));

  const prompt = await mcp.getPrompt({ name: "concierge_intake", arguments: {} });
  const system = (prompt.messages[0]!.content as { text: string }).text.split("\n---\n")[0]!;
  const tools = (await mcp.listTools()).tools.map((t) => ({ name: t.name, description: t.description ?? "", input_schema: t.inputSchema as { type: "object" } }));

  const client = new AnthropicClient();
  const model = process.env.MODEL ?? "claude-opus-5-5";
  const messages: Anthropic.Beta.BetaMessageParam[] = [];

  for (;;) {
    const user = await ask("\nyou> ");
    if (user === undefined) break;
    if (!user.trim()) continue;
    messages.push({ role: "user", content: user });
    for (;;) {
      const res = await client.beta.messages
        .stream({
          model,
          max_tokens: 16000,
          // If the model declines a request, let the API route it to a fallback model.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
          tools,
          messages,
        })
        .finalMessage();
      messages.push({ role: "assistant", content: res.content });
      for (const b of res.content) if (b.type === "text" && b.text.trim()) console.log(`\nconcierge> ${b.text}`);
      if (res.stop_reason === "refusal") {
        console.log("\n(the model declined this request)");
        break;
      }
      if (res.stop_reason !== "tool_use") break;
      const results = [];
      for (const b of res.content) {
        if (b.type !== "tool_use") continue;
        console.log(`   [tool] ${b.name}`);
        const out = await mcp.callTool({ name: b.name, arguments: b.input as Record<string, unknown> });
        results.push({ type: "tool_result" as const, tool_use_id: b.id, is_error: out.isError === true, content: (out.content as { text: string }[]).map((c) => ({ type: "text" as const, text: c.text })) });
      }
      messages.push({ role: "user", content: results });
    }
  }
  await mcp.close();
}

async function openai(): Promise<void> {
  const { Agent, MCPServerStdio, run } = await import("@openai/agents");
  // The Agents SDK does not use MCP prompts, so the agent is told to fetch the guide through a tool.
  // It also has no confirmation dialog, so request_confirmation falls back to the local confirm page.
  const server = new MCPServerStdio({ name: "food-concierge", ...SERVER, env: { ...(process.env as Record<string, string>), MUNCH_LOG: "silent" } });
  await server.connect();
  const agent = new Agent({
    name: "Food Concierge",
    model: process.env.MODEL,
    instructions: "You are Food Concierge. Before anything else, call the get_intake_guide tool and follow it exactly for the whole conversation.",
    mcpServers: [server],
  });
  let history: AgentInputItem[] = [];
  for (;;) {
    const user = await ask("\nyou> ");
    if (user === undefined) break;
    if (!user.trim()) continue;
    const result = await run(agent, [...history, { role: "user", content: user }]);
    history = result.history;
    console.log(`\nconcierge> ${result.finalOutput}`);
  }
  await server.close();
}

try {
  if (llm === "claude") await claude();
  else if (llm === "openai") await openai();
  else console.error("Usage: tsx harness/chat.ts --llm claude|openai");
} catch (e) {
  const status = (e as { status?: number }).status;
  console.error(status === 401 ? "\nThe API rejected the key. Set ANTHROPIC_API_KEY or OPENAI_API_KEY and try again." : `\nStopped: ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
}
rl.close();
process.exit();
