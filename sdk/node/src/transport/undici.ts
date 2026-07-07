// Copyright (c) 2026 Tencent Inc.
// SPDX-License-Identifier: Apache-2.0

import { Agent, buildConnector, request as undiciRequest } from "undici";
import type { Transport, TransportRequest, TransportResponse } from "./types.js";

/**
 * Node/Bun data-plane transport. Connects every request to a fixed proxy
 * IP:port while leaving the `Host` header as the virtual sandbox hostname —
 * equivalent to `curl --resolve host:port:ip`. This is the undici analogue of
 * the Python SDK's `IPOverrideTransport` and is used when `CUBE_PROXY_NODE_IP`
 * is set to bypass DNS resolution of `*.cube.app`.
 */
export class UndiciTransport implements Transport {
  readonly supportsHostOverride = true;
  private readonly agent: Agent;

  constructor(
    private readonly ip: string,
    private readonly port: number,
    private readonly requestTimeoutMs: number,
  ) {
    const base = buildConnector({});
    const connector: buildConnector.connector = (opts, cb) =>
      base({ ...opts, hostname: this.ip, port: String(this.port) }, cb);
    this.agent = new Agent({ connect: connector });
  }

  async request(req: TransportRequest): Promise<TransportResponse> {
    const res = await undiciRequest(req.url, {
      method: req.method as any,
      headers: req.headers,
      body: req.body,
      dispatcher: this.agent,
      signal: req.signal,
      headersTimeout: req.timeoutMs ?? this.requestTimeoutMs,
      // Disable the body/read timeout: streams (watch, pty, execute) are
      // long-lived and undici would otherwise abort them.
      bodyTimeout: 0,
    });

    const headers = new Headers();
    for (const [k, v] of Object.entries(res.headers)) {
      if (v == null) continue;
      headers.set(k, Array.isArray(v) ? v.join(", ") : String(v));
    }

    const body = res.body;
    return {
      status: res.statusCode,
      headers,
      text: () => body.text(),
      bytes: async () => new Uint8Array(await body.arrayBuffer()),
      json: <T>() => body.json() as Promise<T>,
      async *stream() {
        for await (const chunk of body) {
          yield chunk as Uint8Array;
        }
      },
    };
  }

  async close(): Promise<void> {
    await this.agent.close();
  }
}
