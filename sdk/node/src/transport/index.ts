// Copyright (c) 2026 Tencent Inc.
// SPDX-License-Identifier: Apache-2.0

import { runtime } from "../runtime.js";
import { FetchTransport } from "./fetch.js";
import type { Transport, TransportFactoryOptions } from "./types.js";

export type { Transport, TransportRequest, TransportResponse, TransportFactoryOptions } from "./types.js";
export { FetchTransport } from "./fetch.js";

/**
 * Control-plane transport (CubeAPI). Always a plain fetch: the management URL
 * resolves via normal DNS and is never proxied through `CUBE_PROXY_NODE_IP`.
 */
export function createControlTransport(requestTimeoutMs: number): Transport {
  return new FetchTransport(requestTimeoutMs);
}

/**
 * Data-plane transport (CubeProxy → in-sandbox processes). When
 * `proxyNodeIp` is set, picks a runtime-specific adapter capable of
 * connecting to that IP while preserving the virtual `Host` header. Runtimes
 * that cannot do so (Vercel Edge, browser) fall back to plain fetch with
 * `supportsHostOverride = false`; the Sandbox then rejects data-plane calls
 * that require the override with an `UnsupportedRuntimeError`.
 */
export async function createDataTransport(opts: TransportFactoryOptions): Promise<Transport> {
  if (!opts.proxyNodeIp) {
    return new FetchTransport(opts.requestTimeoutMs);
  }

  switch (runtime) {
    case "node":
    case "bun": {
      const { UndiciTransport } = await import("./undici.js");
      return new UndiciTransport(opts.proxyNodeIp, opts.proxyPort, opts.requestTimeoutMs);
    }
    case "deno": {
      const { DenoTransport } = await import("./deno.js");
      return new DenoTransport(opts.proxyNodeIp, opts.proxyPort, opts.requestTimeoutMs);
    }
    case "cloudflare-worker": {
      const { CloudflareTransport } = await import("./cloudflare.js");
      return new CloudflareTransport(opts.proxyNodeIp, opts.proxyPort, opts.requestTimeoutMs);
    }
    default:
      // vercel-edge, browser, unknown: no raw-socket / Host-override capability.
      return new FetchTransport(opts.requestTimeoutMs);
  }
}
