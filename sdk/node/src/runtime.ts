// Copyright (c) 2026 Tencent Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime detection, mirroring E2B's `getRuntime()`.
 *
 * The detected runtime drives transport selection: only some runtimes can
 * connect to a raw IP while preserving a virtual `Host` header (required by
 * `CUBE_PROXY_NODE_IP` DNS bypass).
 */

export type Runtime =
  | "node"
  | "bun"
  | "deno"
  | "vercel-edge"
  | "cloudflare-worker"
  | "browser"
  | "unknown";

const g = globalThis as Record<string, any>;

export function getRuntime(): { runtime: Runtime; version: string } {
  if (g.Bun) {
    return { runtime: "bun", version: String(g.Bun.version ?? "unknown") };
  }
  if (g.Deno) {
    return { runtime: "deno", version: String(g.Deno.version?.deno ?? "unknown") };
  }
  if (g.process?.release?.name === "node") {
    return { runtime: "node", version: String(g.process.versions?.node ?? "unknown") };
  }
  if (typeof g.EdgeRuntime === "string") {
    return { runtime: "vercel-edge", version: g.EdgeRuntime };
  }
  if (g.navigator?.userAgent === "Cloudflare-Workers") {
    return { runtime: "cloudflare-worker", version: "unknown" };
  }
  if (typeof g.window !== "undefined") {
    return { runtime: "browser", version: "unknown" };
  }
  return { runtime: "unknown", version: "unknown" };
}

export const { runtime, version: runtimeVersion } = getRuntime();

/** Read an env var across runtimes (Deno lacks `process.env`). */
export function getEnvVar(name: string): string | undefined {
  if (g.Deno?.env?.get) {
    return g.Deno.env.get(name) ?? undefined;
  }
  if (typeof g.process !== "undefined") {
    return g.process.env?.[name] ?? undefined;
  }
  return undefined;
}
