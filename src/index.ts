#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createContext } from "./context.js";
import { createServer } from "./server.js";

const ctx = createContext();
const server = createServer(ctx);
await server.connect(new StdioServerTransport());
ctx.log.info("started", { mock: ctx.config.enableMock, place_order: ctx.config.enablePlaceOrder, persistent: await ctx.store.persistent() });

const shutdown = async () => {
  await ctx.confirm.close();
  await server.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
