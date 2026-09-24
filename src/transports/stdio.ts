import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createContextBridgeServer } from "../mcp/server.js";

export async function startStdioServer(): Promise<void> {
  const server = createContextBridgeServer();
  await server.connect(new StdioServerTransport());
  const close = async () => {
    await server.close();
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
}
