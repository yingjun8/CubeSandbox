// Copyright (c) 2026 Tencent Inc.
// SPDX-License-Identifier: Apache-2.0

// Hand-written Connect (application/connect+json) protocol helpers. CubeSandbox
// has no protobuf definitions, so — unlike E2B's generated ConnectRPC clients —
// the envd process/filesystem RPCs are framed by hand: a 5-byte envelope
// (1 flag byte + big-endian uint32 length) wraps each JSON message. Mirrors the
// Python SDK's `_encode_connect_envelope` / `_parse_process_start_stream`.

import { base64DecodeToString } from "../base64.js";

export const ENVD_PORT = 49983;
export const CONNECT_PROTOCOL_VERSION = "1";
export const CONNECT_CONTENT_TYPE = "application/connect+json";
export const CONNECT_COMPRESSED_FLAG = 0x01;
export const CONNECT_END_STREAM_FLAG = 0x02;
export const MAX_CONNECT_ENVELOPE_SIZE = 64 * 1024 * 1024;
export const DEFAULT_ENVD_USER = "root";

/** A single decoded Connect frame: its flag byte and raw JSON payload bytes. */
export interface ConnectFrame {
  flags: number;
  payload: Uint8Array;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

function readUint32BE(buf: Uint8Array, offset: number): number {
  return (
    (buf[offset]! * 0x1000000) +
    (buf[offset + 1]! << 16) +
    (buf[offset + 2]! << 8) +
    buf[offset + 3]!
  );
}

/** Prepend a Connect envelope (flags + big-endian length) to a payload. */
export function encodeConnectEnvelope(data: Uint8Array, flags = 0): Uint8Array {
  const header = new Uint8Array(5);
  header[0] = flags & 0xff;
  header[1] = (data.byteLength >>> 24) & 0xff;
  header[2] = (data.byteLength >>> 16) & 0xff;
  header[3] = (data.byteLength >>> 8) & 0xff;
  header[4] = data.byteLength & 0xff;
  return concat(header, data);
}

/** JSON-encode `value` and wrap it in a Connect envelope. */
export function encodeConnectJson(value: unknown, flags = 0): Uint8Array {
  return encodeConnectEnvelope(new TextEncoder().encode(JSON.stringify(value)), flags);
}

/**
 * Split a raw byte stream into Connect frames. Buffers across chunks until a
 * full envelope is available. Compressed frames are rejected (envd never
 * compresses). Trailing partial bytes are ignored on clean close — callers that
 * require an explicit terminator (e.g. an exit code) enforce it themselves.
 */
export async function* iterateConnectFrames(
  stream: AsyncIterable<Uint8Array>,
): AsyncGenerator<ConnectFrame> {
  let buffer: Uint8Array = new Uint8Array(0);
  for await (const chunk of stream) {
    if (!chunk || chunk.byteLength === 0) continue;
    buffer = concat(buffer, chunk);
    while (buffer.byteLength >= 5) {
      const flags = buffer[0]!;
      const size = readUint32BE(buffer, 1);
      if (size > MAX_CONNECT_ENVELOPE_SIZE) {
        throw new Error(`Connect stream message too large: ${size} bytes`);
      }
      if (buffer.byteLength < 5 + size) break;
      const payload = buffer.slice(5, 5 + size);
      buffer = buffer.slice(5 + size);
      if (flags & CONNECT_COMPRESSED_FLAG) {
        throw new Error("unsupported compressed Connect stream message");
      }
      yield { flags, payload };
    }
  }
}

/** Raise if an end-of-stream frame carries a Connect error trailer. */
export function raiseConnectEndStream(payload: Uint8Array): void {
  if (payload.byteLength === 0) return;
  const parsed = JSON.parse(new TextDecoder().decode(payload)) as {
    error?: { message?: string; code?: string };
  };
  const error = parsed.error;
  if (!error) return;
  const message = (error.message || "Connect stream error").trim();
  throw new Error(error.code ? `${error.code}: ${message}` : message);
}

/** Base64-decode process stdout/stderr into a UTF-8 string. */
export function decodeProcessBytes(value: string): string {
  return base64DecodeToString(value);
}

/** Parse a status string like "exit status 7" / "signal 9" into an exit code. */
export function exitCodeFromStatus(status: unknown): number | null {
  if (typeof status !== "string") return null;
  const exit = status.match(/(?:exit status|exited with code)\s+(-?\d+)/);
  if (exit) return Number.parseInt(exit[1]!, 10);
  const signal = status.match(/(?:signal|terminated by signal)\s+(\d+)/);
  if (signal) return 128 + Number.parseInt(signal[1]!, 10);
  if (status === "exited") return 0;
  return null;
}

/** `Authorization: Basic base64("user:")` — envd's per-user auth scheme. */
export function basicAuthUser(user: string): string {
  const token =
    (globalThis as Record<string, any>).Buffer?.from(`${user}:`, "utf-8").toString("base64") ??
    btoa(`${user}:`);
  return `Basic ${token}`;
}

/** Authorization header for a sandbox user, or empty when unset. */
export function userHeaders(user?: string): Record<string, string> {
  return user ? { Authorization: basicAuthUser(user) } : {};
}
