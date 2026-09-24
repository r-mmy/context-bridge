import { isUtf8 } from "node:buffer";
import { open, stat } from "node:fs/promises";
import { TextDecoder } from "node:util";
import type { ProjectRecord } from "../projects/registry.js";
import { ContextBridgeError } from "../security/errors.js";
import { resolveProjectPath } from "../security/paths.js";

export const DEFAULT_OUTPUT_BYTES = 256 * 1024;
export const MAX_OUTPUT_BYTES = 1024 * 1024;
export const MAX_SCAN_BYTES = 4 * 1024 * 1024;

export function truncateUtf8(buffer: Buffer, maxBytes: number): Buffer {
  const end = Math.min(buffer.length, Math.max(0, maxBytes));
  if (end === buffer.length || end === 0) return buffer.subarray(0, end);

  let sequenceStart = end - 1;
  while (
    sequenceStart >= 0 &&
    (buffer[sequenceStart]! & 0b1100_0000) === 0b1000_0000
  ) {
    sequenceStart -= 1;
  }
  if (sequenceStart < 0) return buffer.subarray(0, end);

  const lead = buffer[sequenceStart]!;
  const expectedLength =
    lead >= 0xf0 && lead <= 0xf4
      ? 4
      : lead >= 0xe0 && lead <= 0xef
        ? 3
        : lead >= 0xc2 && lead <= 0xdf
          ? 2
          : 1;
  if (sequenceStart + expectedLength > end)
    return buffer.subarray(0, sequenceStart);
  return buffer.subarray(0, end);
}

export interface ReadTextResult {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number | null;
  truncated: boolean;
  text: string;
}

export function clampOutputBytes(value: number | undefined): number {
  const requested = value ?? DEFAULT_OUTPUT_BYTES;
  if (
    !Number.isInteger(requested) ||
    requested < 1 ||
    requested > MAX_OUTPUT_BYTES
  ) {
    throw new ContextBridgeError(
      "invalid_limit",
      `max_bytes must be between 1 and ${MAX_OUTPUT_BYTES}.`,
    );
  }
  return requested;
}

function decodeUtf8(buffer: Buffer, stream: boolean): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer, { stream });
  } catch {
    throw new ContextBridgeError(
      "binary_file",
      "Binary or non-UTF-8 files cannot be returned as text.",
    );
  }
}

function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}

export async function readTextFile(
  project: ProjectRecord,
  relativePath: string,
  options: { startLine?: number; maxLines?: number; maxBytes?: number } = {},
): Promise<ReadTextResult> {
  const startLine = options.startLine ?? 1;
  const maxLines = options.maxLines ?? 400;
  const maxBytes = clampOutputBytes(options.maxBytes);
  if (!Number.isInteger(startLine) || startLine < 1) {
    throw new ContextBridgeError(
      "invalid_line_range",
      "start_line must be an integer of at least 1.",
    );
  }
  if (!Number.isInteger(maxLines) || maxLines < 1 || maxLines > 2000) {
    throw new ContextBridgeError(
      "invalid_line_range",
      "max_lines must be between 1 and 2000.",
    );
  }

  const resolved = await resolveProjectPath(project, relativePath);
  const details = await stat(resolved.absolutePath);
  if (!details.isFile())
    throw new ContextBridgeError(
      "not_a_file",
      "The requested path is not a regular file.",
    );
  const handle = await open(resolved.absolutePath, "r");
  let buffer: Buffer;
  try {
    const readLength = Math.min(details.size, MAX_SCAN_BYTES);
    buffer = Buffer.alloc(readLength);
    if (readLength > 0) await handle.read(buffer, 0, readLength, 0);
  } finally {
    await handle.close();
  }
  if (buffer.includes(0)) {
    throw new ContextBridgeError(
      "binary_file",
      "Binary files cannot be returned as text.",
    );
  }
  const scanTruncated = details.size > buffer.length;
  const text = decodeUtf8(buffer, scanTruncated);
  const lines = splitLines(text);
  const totalLines = scanTruncated ? null : lines.length;
  const offset = startLine - 1;
  const selected = lines.slice(offset, offset + maxLines);
  const output: string[] = [];
  let usedBytes = 0;
  let byteTruncated = false;
  for (const line of selected) {
    const separatorBytes = output.length > 0 ? 1 : 0;
    const remaining = maxBytes - usedBytes - separatorBytes;
    const lineBuffer = Buffer.from(line, "utf8");
    if (lineBuffer.byteLength <= remaining) {
      output.push(line);
      usedBytes += separatorBytes + lineBuffer.byteLength;
      continue;
    }
    if (remaining > 0) {
      const partial = truncateUtf8(lineBuffer, remaining);
      if (partial.length > 0)
        output.push(new TextDecoder("utf-8", { fatal: true }).decode(partial));
    }
    byteTruncated = true;
    break;
  }
  const endLine =
    output.length > 0
      ? startLine + output.length - 1
      : Math.max(0, startLine - 1);
  const linesTruncated =
    selected.length < Math.min(maxLines, Math.max(lines.length - offset, 0));
  return {
    path: resolved.relativePath,
    startLine,
    endLine,
    totalLines,
    truncated:
      scanTruncated ||
      byteTruncated ||
      linesTruncated ||
      (totalLines !== null && endLine < totalLines),
    text: output.join("\n"),
  };
}

export async function readSearchText(
  project: ProjectRecord,
  relativePath: string,
  maxBytes = 1024 * 1024,
): Promise<{ lines: string[]; truncated: boolean }> {
  const resolved = await resolveProjectPath(project, relativePath);
  const details = await stat(resolved.absolutePath);
  if (!details.isFile() || details.size === 0)
    return { lines: [], truncated: false };
  const readLength = Math.min(details.size, maxBytes);
  const handle = await open(resolved.absolutePath, "r");
  let buffer: Buffer;
  try {
    buffer = Buffer.alloc(readLength);
    if (readLength > 0) await handle.read(buffer, 0, readLength, 0);
  } finally {
    await handle.close();
  }
  if (buffer.includes(0)) return { lines: [], truncated: false };
  const isTruncated = details.size > buffer.length;
  try {
    if (!isTruncated && !isUtf8(buffer)) return { lines: [], truncated: false };
    return {
      lines: splitLines(decodeUtf8(buffer, isTruncated)),
      truncated: isTruncated,
    };
  } catch {
    return { lines: [], truncated: false };
  }
}
