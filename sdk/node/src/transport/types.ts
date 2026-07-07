// Copyright (c) 2026 Tencent Inc.
// SPDX-License-Identifier: Apache-2.0

/** A single request issued by the SDK, independent of the underlying runtime. */
export interface TransportRequest {
  method: string;
  /** Logical URL using the virtual host (e.g. http://49999-<id>.cube.app/...). */
  url: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
  signal?: AbortSignal;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
}

/** A response with lazy body accessors and a streaming iterator. */
export interface TransportResponse {
  status: number;
  headers: Headers;
  text(): Promise<string>;
  bytes(): Promise<Uint8Array>;
  json<T = unknown>(): Promise<T>;
  /** Raw byte chunks, for ndjson / Connect frame parsing. */
  stream(): AsyncIterable<Uint8Array>;
}

/**
 * Abstraction over the network layer. Different runtimes plug in different
 * implementations; the Sandbox core never talks to fetch/undici directly.
 */
export interface Transport {
  request(req: TransportRequest): Promise<TransportResponse>;
  /**
   * Whether this transport can connect to a raw IP while preserving the
   * virtual `Host` header. Required to serve the data plane when
   * `CUBE_PROXY_NODE_IP` is set. `false` for fetch-only runtimes.
   */
  readonly supportsHostOverride: boolean;
  /** Release pooled connections, if any. */
  close?(): Promise<void> | void;
}

/** Options passed to the transport factory. */
export interface TransportFactoryOptions {
  /** When set, the data plane must route to this IP with Host preserved. */
  proxyNodeIp?: string;
  proxyPort: number;
  /** Default connect timeout in milliseconds. */
  requestTimeoutMs: number;
}
