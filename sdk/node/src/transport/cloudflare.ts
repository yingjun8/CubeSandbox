// Copyright (c) 2026 Tencent Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Transport, TransportRequest, TransportResponse } from "./types.js";

async function* readStream(body: ReadableStream<Uint8Array> | null): AsyncIterable<Uint8Array> {
  if (!body) return;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Cloudflare Workers data-plane transport. Uses the Workers-specific
 * `cf.resolveOverride` fetch option to connect to the proxy IP while keeping
 * the request URL's virtual hostname (and thus the `Host` header) intact.
 *
 * Note: `resolveOverride` is a best-effort Cloudflare feature and may be
 * restricted on some account tiers. If it is unavailable, users can inject a
 * `cloudflare:sockets`-based custom transport via `Sandbox.create({ transport })`.
 */
export class CloudflareTransport implements Transport {
  readonly supportsHostOverride = true;

  constructor(
    private readonly ip: string,
    private readonly _port: number,
    private readonly requestTimeoutMs: number,
  ) {}

  async request(req: TransportRequest): Promise<TransportResponse> {
    const signal =
      req.timeoutMs && req.timeoutMs > 0 && typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(req.timeoutMs)
        : req.signal;

    const init = {
      method: req.method,
      headers: req.headers,
      body: req.body as BodyInit | undefined,
      signal,
      cf: { resolveOverride: this.ip },
    } as RequestInit & { cf: { resolveOverride: string } };

    const resp = await fetch(req.url, init as RequestInit);
    return {
      status: resp.status,
      headers: resp.headers,
      text: () => resp.text(),
      bytes: async () => new Uint8Array(await resp.arrayBuffer()),
      json: <T>() => resp.json() as Promise<T>,
      stream: () => readStream(resp.body),
    };
  }
}
