// Copyright (c) 2026 Tencent Inc.
// SPDX-License-Identifier: Apache-2.0

// Runtime-agnostic base64 helpers. Prefer Node/Bun's `Buffer` when present;
// fall back to the web `btoa`/`atob` + `TextEncoder`/`TextDecoder` on Deno,
// Cloudflare, and browsers.

const BufferCtor: typeof import("buffer").Buffer | undefined = (globalThis as Record<string, any>).Buffer;

/** Base64-encode a UTF-8 string. */
export function base64Encode(input: string): string {
  if (BufferCtor) return BufferCtor.from(input, "utf-8").toString("base64");
  const bytes = new TextEncoder().encode(input);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Decode base64 into a UTF-8 string. */
export function base64DecodeToString(b64: string): string {
  if (BufferCtor) return BufferCtor.from(b64, "base64").toString("utf-8");
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Base64-encode raw bytes (not UTF-8 text). */
export function base64EncodeBytes(bytes: Uint8Array): string {
  if (BufferCtor) return BufferCtor.from(bytes).toString("base64");
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Decode base64 into raw bytes. */
export function base64DecodeToBytes(b64: string): Uint8Array {
  if (BufferCtor) return new Uint8Array(BufferCtor.from(b64, "base64"));
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
