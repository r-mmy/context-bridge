import { createServer } from "node:http";
import type { Server } from "node:http";
import { createMcpHandler } from "@modelcontextprotocol/server";
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import { createContextBridgeServer } from "../mcp/server.js";
import { ContextBridgeError } from "../security/errors.js";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 7331;

export function createHttpServer(): Server {
  const handler = createMcpHandler(() => createContextBridgeServer());
  const nodeHandler = toNodeHandler(handler);
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  return createServer((request, response) => {
    if (request.url?.split("?", 1)[0] !== "/mcp") {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    if (
      !validateHost(request as Parameters<typeof validateHost>[0], response) ||
      !validateOrigin(request as Parameters<typeof validateOrigin>[0], response)
    )
      return;
    void nodeHandler(
      request as Parameters<typeof nodeHandler>[0],
      response,
    ).catch(() => {
      if (!response.headersSent)
        response.writeHead(500, {
          "content-type": "text/plain; charset=utf-8",
        });
      if (!response.writableEnded) response.end("MCP request failed");
    });
  });
}

export async function listenHttpServer(
  httpServer: Server,
  port: number,
): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, HOST, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });
  const address = httpServer.address();
  return typeof address === "object" && address ? address.port : port;
}

export async function startHttpServer(port = DEFAULT_PORT): Promise<void> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ContextBridgeError(
      "invalid_port",
      "port must be between 1 and 65535.",
    );
  }
  const httpServer = createHttpServer();
  const actualPort = await listenHttpServer(httpServer, port);
  console.error(
    `Context Bridge MCP listening at http://${HOST}:${actualPort}/mcp`,
  );

  const close = () => {
    httpServer.close((error) => {
      if (error) process.exitCode = 1;
    });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
