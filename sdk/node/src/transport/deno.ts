// Copyright (c) 2026 Tencent Inc.
// SPDX-License-Identifier: Apache-2.0

import { http1Request, type RawSocket } from "./http1.js";
import type { Transport, TransportRequest, TransportResponse } from "./types.js";

// `Deno` is a runtime global not present in Node's type environment.
const DenoGlobal = (globalThis as Record<string, any>).Deno;

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const c of stream) {
    chunks.push(c);
    total += c.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function toBytes(body: Uint8Array | string | undefined): Uint8Array | undefined {
  if (body == null) return undefined;
  return typeof body === "string" ? new TextEncoder().encode(body) : body;
}

/**
 * Deno data-plane transport. Uses `Deno.connect` for a raw TCP socket to the
 * proxy IP, then speaks HTTP/1.1 manually with the virtual sandbox hostname in
 * the `Host` header — the capability Deno's `fetch` cannot provide.
 */
export class DenoTransport implements Transport {
  readonly supportsHostOverride = true;

  constructor(
    private readonly ip: string,
    private readonly port: number,
    private readonly _requestTimeoutMs: number,
  ) {}

  async request(req: TransportRequest): Promise<TransportResponse> {
    const url = new URL(req.url);
    const conn = await DenoGlobal.connect({ hostname: this.ip, port: this.port });
    const reader = conn.readable.getReader();
    const socket: RawSocket = {
      write: async (data) => {
        await conn.write(data);
      },
      read: () => ({
        next: async () => {
          const { done, value } = await reader.read();
          return done ? { done: true, value: undefined } : { done: false, value };
        },
      }),
      close: () => {
        try {
          reader.releaseLock();
          conn.close();
        } catch {
          /* already closed */
        }
      },
    };

    const res = await http1Request(socket, {
      method: req.method,
      path: url.pathname + url.search,
      host: url.host,
      headers: req.headers,
      body: toBytes(req.body),
    });

    let cached: Uint8Array | undefined;
    const bytes = async () => (cached ??= await collect(res.stream));
    return {
      status: res.status,
      headers: res.headers,
      bytes,
      text: async () => new TextDecoder().decode(await bytes()),
      json: async <T>() => JSON.parse(new TextDecoder().decode(await bytes())) as T,
      stream: () => res.stream,
    };
  }
}
