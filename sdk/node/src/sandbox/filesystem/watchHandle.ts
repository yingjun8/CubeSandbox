// Copyright (c) 2026 Tencent Inc.
// SPDX-License-Identifier: Apache-2.0

// Streaming directory watcher over envd's `WatchDir` Connect RPC. Mirrors the
// Python SDK's `_filesystem.Watcher`.

import {
  CONNECT_END_STREAM_FLAG,
  iterateConnectFrames,
} from "../../envd/connect.js";
import type { TransportResponse } from "../../transport/types.js";

/** A single filesystem change event with `name` and `type` fields. */
export interface WatchEvent {
  name: string;
  type: string;
  [key: string]: unknown;
}

/**
 * Async-iterable handle over a `WatchDir` stream. Iterate it with `for await`;
 * call {@link close} (or `break` the loop) to abort the underlying request.
 *
 * @example
 * ```ts
 * const w = await sb.files.watchDir("/tmp");
 * try {
 *   for await (const ev of w) console.log(ev.name, ev.type);
 * } finally {
 *   w.close();
 * }
 * ```
 */
export class WatchHandle implements AsyncIterable<WatchEvent> {
  private closed = false;

  constructor(
    private readonly response: TransportResponse,
    private readonly controller: AbortController,
  ) {}

  /** Abort the stream and release the connection. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<WatchEvent> {
    try {
      for await (const { flags, payload } of iterateConnectFrames(this.response.stream())) {
        if (this.closed) return;
        const data = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
        if (flags & CONNECT_END_STREAM_FLAG) {
          const err = data.error as { message?: string } | undefined;
          if (err) throw new Error(err.message || "watch stream error");
          return;
        }
        const fs = data.filesystem as Record<string, unknown> | undefined;
        if (fs) {
          yield { name: (fs.name as string) ?? "", type: (fs.type as string) ?? "", ...fs };
        }
      }
    } catch (e) {
      if (this.closed) return; // abort() surfaces as a throw — swallow after close
      throw e;
    }
  }
}
