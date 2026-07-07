// Copyright (c) 2026 Tencent Inc.
// SPDX-License-Identifier: Apache-2.0

// Pseudo-terminal (PTY) interface over envd's Process Connect RPC. Streaming
// calls (Start/Connect) use the framed application/connect+json wire format;
// selector calls (SendSignal/SendInput/Update) are unary application/json.
// Mirrors the Python SDK's `_pty.Pty` / `_pty.PtyHandle`.

import { base64DecodeToBytes, base64EncodeBytes } from "../../base64.js";
import { CubeSandboxError } from "../../errors.js";
import {
  CONNECT_CONTENT_TYPE,
  CONNECT_END_STREAM_FLAG,
  CONNECT_PROTOCOL_VERSION,
  DEFAULT_ENVD_USER,
  ENVD_PORT,
  encodeConnectJson,
  exitCodeFromStatus,
  iterateConnectFrames,
  raiseConnectEndStream,
  userHeaders,
} from "../../envd/connect.js";
import { dataHeaders, type DataPlane } from "../../envd/api.js";
import type { TransportResponse } from "../../transport/types.js";

/** Raw bytes streamed from the PTY master side. */
export type PtyOutput = Uint8Array;

/** Pseudo-terminal window size. */
export interface PtySize {
  rows: number;
  cols: number;
}

/** Options for {@link Pty.create}. */
export interface PtyCreateOptions {
  user?: string;
  cwd?: string;
  envs?: Record<string, string>;
  /** Server-side PTY timeout in milliseconds (sent as `Connect-Timeout-Ms`). */
  timeoutMs?: number;
}

/** Options for {@link Pty.connect}. */
export interface PtyConnectOptions {
  timeoutMs?: number;
}

/** The Connect-JSON Signal enum value for SIGKILL (string name, not integer). */
const SIGNAL_SIGKILL = "SIGNAL_SIGKILL";

/** A single decoded ProcessEvent `event` field: start / data / end. */
type ProcessEvent = {
  start?: { pid?: number };
  data?: { pty?: string };
  end?: Record<string, unknown>;
};

/**
 * Handle to a running PTY. Iterate it with `for await` to receive
 * {@link PtyOutput} chunks until the process exits or you {@link disconnect}.
 */
export class PtyHandle implements AsyncIterable<PtyOutput> {
  private _exitCode: number | null = null;
  private _error: string | null = null;
  private _exited = false;

  constructor(
    private readonly _pid: number,
    private readonly events: AsyncGenerator<ProcessEvent>,
    private readonly handleKill: () => Promise<boolean>,
    private readonly handleSendStdin: (data: Uint8Array, timeoutMs?: number) => Promise<void>,
    private readonly handleResize: (size: PtySize, timeoutMs?: number) => Promise<void>,
  ) {}

  /** PTY process ID. */
  get pid(): number {
    return this._pid;
  }

  /** Exit code once the process has finished, otherwise `null`. */
  get exitCode(): number | null {
    return this._exitCode;
  }

  /** Error message reported by envd for the PTY, if any. */
  get error(): string | null {
    return this._error;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<PtyOutput> {
    try {
      for await (const event of this.events) {
        const pty = event.data?.pty;
        if (pty) yield base64DecodeToBytes(pty);
        if (event.end != null) {
          this._exitCode = extractExitCode(event.end);
          this._error = (event.end.error as string) || null;
          this._exited = true;
        }
      }
    } finally {
      await this.events.return?.(undefined);
    }
  }

  /**
   * Block until the PTY exits and return its exit code, invoking `onData` for
   * each output chunk.
   */
  async wait(onData?: (chunk: PtyOutput) => void): Promise<number> {
    for await (const chunk of this) {
      if (onData) onData(chunk);
    }
    if (!this._exited) throw new CubeSandboxError("PTY stream ended without an end event");
    if (this._error) throw new CubeSandboxError(`PTY exited with error: ${this._error}`);
    return this._exitCode ?? 0;
  }

  /** Stop receiving events without killing the PTY; reconnect later via {@link Pty.connect}. */
  async disconnect(): Promise<void> {
    await this.events.return?.(undefined);
  }

  /** Send `SIGKILL` to the PTY process. Returns `false` if it no longer exists. */
  kill(): Promise<boolean> {
    return this.handleKill();
  }

  /** Send input to the PTY master side. */
  sendStdin(data: string | Uint8Array, timeoutMs?: number): Promise<void> {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    return this.handleSendStdin(bytes, timeoutMs);
  }

  /** Resize the PTY window. */
  resize(size: PtySize, timeoutMs?: number): Promise<void> {
    return this.handleResize(size, timeoutMs);
  }
}

/**
 * PTY namespace: `create` to start an interactive shell, `connect` to reattach,
 * plus `kill`/`sendStdin`/`resize` for control by PID without a handle.
 */
export class Pty {
  constructor(private readonly dp: DataPlane) {}

  private url(method: string): string {
    return `http://${this.dp.getHost(ENVD_PORT)}/process.Process/${method}`;
  }

  private headers(streaming: boolean, user?: string, timeoutMs?: number): Record<string, string> {
    const headers: Record<string, string> = streaming
      ? {
          "Content-Type": CONNECT_CONTENT_TYPE,
          "Connect-Protocol-Version": CONNECT_PROTOCOL_VERSION,
          "Connect-Content-Encoding": "identity",
        }
      : {
          "Content-Type": "application/json",
          "Connect-Protocol-Version": CONNECT_PROTOCOL_VERSION,
        };
    if (timeoutMs != null && timeoutMs > 0) {
      headers["Connect-Timeout-Ms"] = String(Math.trunc(timeoutMs));
    }
    Object.assign(headers, dataHeaders(this.dp));
    if (user) Object.assign(headers, userHeaders(user));
    return headers;
  }

  /** Send a unary Connect-JSON request (bare application/json, no envelope). */
  private async unary(
    method: string,
    payload: Record<string, unknown>,
    options: { user?: string; timeoutMs?: number; allowNotFound?: boolean } = {},
  ): Promise<Record<string, unknown> | null> {
    const transport = await this.dp.dataTransport();
    const res = await transport.request({
      method: "POST",
      url: this.url(method),
      headers: this.headers(false, options.user, options.timeoutMs),
      body: JSON.stringify(payload),
    });
    if (res.status >= 400) {
      const raw = await res.text().catch(() => "");
      if (options.allowNotFound && isNotFound(res.status, raw)) return null;
      const detail = errorDetail(raw) || `HTTP ${res.status}`;
      throw new CubeSandboxError(`${method} failed: HTTP ${res.status}: ${detail}`, res.status);
    }
    const text = await res.text();
    if (!text) return {};
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch (e) {
      throw new CubeSandboxError(`${method}: invalid JSON response: ${(e as Error).message}`);
    }
  }

  /** Send `SIGKILL` to a PTY by PID. Returns `false` if it was not found. */
  async kill(pid: number, timeoutMs?: number): Promise<boolean> {
    const result = await this.unary(
      "SendSignal",
      { process: { pid }, signal: SIGNAL_SIGKILL },
      { timeoutMs, allowNotFound: true },
    );
    return result !== null;
  }

  /** Send input to a PTY identified by `pid`. */
  async sendStdin(pid: number, data: string | Uint8Array, timeoutMs?: number): Promise<void> {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    await this.unary(
      "SendInput",
      { process: { pid }, input: { pty: base64EncodeBytes(bytes) } },
      { timeoutMs },
    );
  }

  /** Resize a running PTY. */
  async resize(pid: number, size: PtySize, timeoutMs?: number): Promise<void> {
    await this.unary(
      "Update",
      { process: { pid }, pty: { size: { rows: size.rows, cols: size.cols } } },
      { timeoutMs },
    );
  }

  /** Start a new PTY running an interactive login bash shell. */
  async create(size: PtySize, options: PtyCreateOptions = {}): Promise<PtyHandle> {
    const envs: Record<string, string> = { ...(options.envs ?? {}) };
    envs.TERM ??= "xterm-256color";
    envs.LANG ??= "C.UTF-8";
    envs.LC_ALL ??= "C.UTF-8";
    const user = options.user || DEFAULT_ENVD_USER;

    const process: Record<string, unknown> = { cmd: "/bin/bash", args: ["-i", "-l"], envs };
    if (options.cwd) process.cwd = options.cwd;

    return this.openStream(
      "Start",
      { process, pty: { size: { rows: size.rows, cols: size.cols } } },
      { user, timeoutMs: options.timeoutMs ?? 60_000 },
    );
  }

  /** Reattach to an already-running PTY by PID. */
  async connect(pid: number, options: PtyConnectOptions = {}): Promise<PtyHandle> {
    return this.openStream("Connect", { process: { pid } }, { timeoutMs: options.timeoutMs ?? 60_000 });
  }

  private async openStream(
    method: string,
    payload: Record<string, unknown>,
    options: { user?: string; timeoutMs?: number },
  ): Promise<PtyHandle> {
    const controller = new AbortController();
    const transport = await this.dp.dataTransport();
    const res = await transport.request({
      method: "POST",
      url: this.url(method),
      headers: this.headers(true, options.user, options.timeoutMs),
      body: encodeConnectJson(payload),
      signal: controller.signal,
    });
    if (res.status >= 400) {
      const detail = await httpErrorDetail(res);
      throw new CubeSandboxError(
        `${method} failed: HTTP ${res.status}${detail ? `: ${detail}` : ""}`,
        res.status,
      );
    }

    const events = iterateProcessEvents(res, controller);
    let first: IteratorResult<ProcessEvent>;
    try {
      first = await events.next();
    } catch (e) {
      controller.abort();
      throw e;
    }
    if (first.done) {
      controller.abort();
      throw new CubeSandboxError(`${method}: stream closed before start event`);
    }
    const pid = first.value.start?.pid;
    if (pid == null) {
      controller.abort();
      throw new CubeSandboxError(`${method}: expected start event, got ${JSON.stringify(first.value)}`);
    }

    return new PtyHandle(
      Number(pid),
      events,
      () => this.kill(Number(pid)),
      (data, timeoutMs) => this.sendStdin(Number(pid), data, timeoutMs),
      (size, timeoutMs) => this.resize(Number(pid), size, timeoutMs),
    );
  }
}

/** Yield the `event` field of each ProcessEvent JSON message from a stream. */
async function* iterateProcessEvents(
  response: TransportResponse,
  controller: AbortController,
): AsyncGenerator<ProcessEvent> {
  try {
    for await (const { flags, payload } of iterateConnectFrames(response.stream())) {
      if (flags & CONNECT_END_STREAM_FLAG) {
        raiseConnectEndStream(payload);
        return;
      }
      const message = JSON.parse(new TextDecoder().decode(payload)) as { event?: ProcessEvent };
      if (message.event != null) yield message.event;
    }
  } finally {
    controller.abort();
  }
}

/** Best-effort exit-code extraction from a Process end event. */
function extractExitCode(end: Record<string, unknown>): number | null {
  if ("exitCode" in end) return Number(end.exitCode);
  if ("exit_code" in end) return Number(end.exit_code);
  const fromStatus = exitCodeFromStatus(end.status);
  if (fromStatus != null) return fromStatus;
  if (end.exited) return 0;
  return null;
}

/** Detect Connect's `not_found` code from an error status + body text. */
function isNotFound(status: number, raw: string): boolean {
  if (status === 404) return true;
  try {
    const body = JSON.parse(raw) as Record<string, unknown>;
    const code = body.code;
    return typeof code === "string" && code.toLowerCase() === "not_found";
  } catch {
    return false;
  }
}

/** Pull a human-readable message out of an error body (JSON `message`/`error.message` or raw text). */
function errorDetail(raw: string): string {
  const text = raw.trim();
  if (!text) return "";
  try {
    const payload = JSON.parse(text) as Record<string, unknown>;
    const message =
      (payload.message as string) || ((payload.error as Record<string, unknown>)?.message as string);
    if (typeof message === "string" && message.trim()) return message.trim();
  } catch {
    /* not JSON — fall through to raw text */
  }
  return text;
}

async function httpErrorDetail(res: TransportResponse): Promise<string> {
  const raw = await res.text().catch(() => "");
  return errorDetail(raw);
}
