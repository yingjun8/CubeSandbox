// Copyright (c) 2026 Tencent Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Transport, TransportRequest, TransportResponse } from "./types.js";

/** Iterate a web ReadableStream on runtimes where it is not async-iterable. */
async function* readStream(body: ReadableStream<Uint8Array> | null): AsyncIterable<Uint8Array> {
  if (!body) return;
  if (Symbol.asyncIterator in body) {
    yield* body as unknown as AsyncIterable<Uint8Array>;
    return;
  }
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

function wrap(resp: Response): TransportResponse {
  return {
    status: resp.status,
    headers: resp.headers,
    text: () => resp.text(),
    bytes: async () => new Uint8Array(await resp.arrayBuffer()),
    json: <T>() => resp.json() as Promise<T>,
    stream: () => readStream(resp.body),
  };
}

/**
 * Universal transport built on the global `fetch`. Works on every runtime for
 * the control plane and for the data plane when `*.cube.app` resolves via real
 * DNS. Cannot connect-to-IP-while-preserving-Host, so `supportsHostOverride`
 * is false — the Sandbox rejects data-plane calls needing IP override here.
 */
export class FetchTransport implements Transport {
  readonly supportsHostOverride = false;

  constructor(private readonly requestTimeoutMs: number) {}

  async request(req: TransportRequest): Promise<TransportResponse> {
    const signal = mergeSignal(req.signal, req.timeoutMs ?? this.requestTimeoutMs);
    const resp = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body as BodyInit | undefined,
      signal,
      redirect: "follow",
    });
    return wrap(resp);
  }
}

function mergeSignal(external: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal | undefined {
  const timeoutSignal =
    timeoutMs && timeoutMs > 0 && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
  if (external && timeoutSignal && typeof (AbortSignal as any).any === "function") {
    return (AbortSignal as any).any([external, timeoutSignal]);
  }
  return external ?? timeoutSignal;
}
