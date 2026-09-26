import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createContextBridgeServer } from "../mcp/server.js";
import { LazyTaskToolHost } from "../mcp/task-host.js";

export async function startStdioServer(): Promise<void> {
  const taskHost = new LazyTaskToolHost();
  const server = createContextBridgeServer({ taskHost });
  try {
    await server.connect(new StdioServerTransport());
  } catch (error) {
    await taskHost.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    throw error;
  }
  let shutdown: Promise<void> | undefined;
  const close = () => {
    shutdown ??= (async () => {
      let failed = false;
      try {
        await taskHost.close();
      } catch {
        failed = true;
        console.error(
          "Context Bridge task shutdown was uncertain; task runtime ownership was retained.",
        );
      }
      await server.close().catch(() => {
        failed = true;
      });
      if (failed) process.exitCode = 1;
    })();
    void shutdown;
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
