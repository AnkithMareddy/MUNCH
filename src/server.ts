import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppContext } from "./context.js";
import { intakeGuide, SERVER_INSTRUCTIONS } from "./prompts/guide.js";
import { registerCheckoutTools } from "./tools/checkout.js";
import { registerProviderTools } from "./tools/providers.js";
import { registerShoppingTools } from "./tools/shopping.js";

export const VERSION = "0.1.0";

export function createServer(ctx: AppContext): McpServer {
  const server = new McpServer({ name: "food-concierge", title: "Food Concierge", version: VERSION }, { instructions: SERVER_INSTRUCTIONS });

  registerProviderTools(server, ctx);
  registerShoppingTools(server, ctx);
  registerCheckoutTools(server, ctx);

  server.registerPrompt(
    "concierge_intake",
    {
      title: "Food Concierge",
      description: "Start a food order: a few short questions, then the same order priced on every delivery app you use.",
      argsSchema: { mood: z.string().optional().describe("What you're in the mood for, if you already know") },
    },
    ({ mood }) => ({
      messages: [{ role: "user", content: { type: "text", text: `${intakeGuide({ mood })}\n\n---\n${mood ? `I'm in the mood for: ${mood}` : "I'm hungry. Help me order."}` } }],
    }),
  );

  return server;
}
