import { ContextBridgeError } from "../security/errors.js";

// The MCP envelope duplicates the JSON value as text and structured content.
// Bound the complete encoded result as well as each tool's source data.
const MAX_MCP_ENVELOPE_BYTES = 16 * 1024 * 1024;

export function jsonResult(value: unknown) {
  const serialized = JSON.stringify(value);
  const structuredContent = value as Record<string, unknown>;
  const result = {
    content: [{ type: "text" as const, text: serialized }],
    structuredContent,
  };
  if (
    Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_MCP_ENVELOPE_BYTES
  ) {
    throw new ContextBridgeError(
      "output_limit",
      "The result exceeded the 16 MiB encoded MCP response limit.",
    );
  }
  return result;
}
