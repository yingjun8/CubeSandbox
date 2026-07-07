// Copyright (c) 2026 Tencent Inc.
// SPDX-License-Identifier: Apache-2.0

import { ApiError } from "../errors.js";
import { Config } from "../config.js";
import { createDataTransport } from "../transport/index.js";
import type { Transport } from "../transport/types.js";
import { dataHeaders, type DataPlane } from "../envd/api.js";
import { Execution } from "../models.js";
import { iterateNdjsonLines, parseLine, type RunCodeCallbacks } from "../envd/stream.js";
import { Commands } from "./commands/index.js";
import { Pty } from "./commands/pty.js";
import { Filesystem } from "./filesystem/index.js";
import {
  SandboxApi,
  resolveConfig,
  type ConnectOptions,
  type CreateOptions,
  type ListSnapshotsOptions,
  type PauseOptions,
  type SandboxData,
  type SnapshotPage,
} from "./sandboxApi.js";
import type { SnapshotInfo } from "../models.js";

export type {
  SandboxData,
  NetworkPolicy,
  Lifecycle,
  CreateOptions,
  ConnectOptions,
  ListSnapshotsOptions,
  PauseOptions,
  SnapshotPage,
} from "./sandboxApi.js";
export { Commands, Pty, PtyHandle } from "./commands/index.js";
export type {
  CommandResult,
  CommandRunOptions,
  PtySize,
  PtyOutput,
  PtyCreateOptions,
  PtyConnectOptions,
} from "./commands/index.js";
export { Filesystem, WatchHandle } from "./filesystem/index.js";
export type { FileEntry, FsUserOptions, WatchEvent } from "./filesystem/index.js";
export type { RunCodeCallbacks } from "../envd/stream.js";

/** The default Jupyter/execute port inside a sandbox. */
export const JUPYTER_PORT = 49999;

/** Options for {@link Sandbox.runCode}. */
export interface RunCodeOptions extends RunCodeCallbacks {
  /** Kernel language override. Omit to use the sandbox's global namespace. */
  language?: string;
  /** Per-execution environment variables. */
  envs?: Record<string, string>;
}

/**
 * A CubeSandbox code-execution environment.
 *
 * @example
 * ```ts
 * const sb = await Sandbox.create();
 * try {
 *   const exec = await sb.runCode("print('hi')");
 *   console.log(exec.text);
 * } finally {
 *   await sb.kill();
 * }
 * ```
 */
export class Sandbox extends SandboxApi implements DataPlane {
  private readonly data: SandboxData;
  readonly config: Config;

  /** Shell command execution inside the sandbox. */
  readonly commands: Commands;
  /** Filesystem access inside the sandbox. */
  readonly files: Filesystem;
  /** Pseudo-terminal (PTY) access inside the sandbox. */
  readonly pty: Pty;

  private _dataTransport?: Transport;

  constructor(data: SandboxData, config: Config | undefined = undefined) {
    super();
    this.data = data;
    this.config = config instanceof Config ? config : resolveConfig(config);
    this.commands = new Commands(this);
    this.files = new Filesystem(this);
    this.pty = new Pty(this);
  }

  get sandboxId(): string {
    return this.data.sandboxID;
  }

  get templateId(): string {
    return this.data.templateID;
  }

  get domain(): string {
    return this.data.domain || this.config.sandboxDomain;
  }

  /**
   * Per-sandbox token returned when `network.allowPublicTraffic=false`. Send it
   * as `e2b-traffic-access-token` (or `cube-traffic-access-token`) on requests
   * to the sandbox's public URL. `undefined` for publicly reachable sandboxes,
   * and for instances obtained via {@link Sandbox.connect} (the token is only
   * delivered on the original create response).
   */
  get trafficAccessToken(): string | undefined {
    return this.data.trafficAccessToken || undefined;
  }

  /** Access token for the in-sandbox envd data plane, if the API returned one. */
  get envdAccessToken(): string | undefined {
    return this.data.envdAccessToken || undefined;
  }

  /** Virtual hostname for a sandbox port, e.g. `49999-<sandboxID>.cube.app`. */
  getHost(port: number): string {
    return `${port}-${this.sandboxId}.${this.domain}`;
  }

  /**
   * Lazily build and cache the shared data-plane transport (CubeProxy-routed).
   * When `CUBE_PROXY_NODE_IP` is set, this picks a runtime adapter capable of
   * connecting to that IP while preserving the virtual `Host` header.
   */
  async dataTransport(): Promise<Transport> {
    if (!this._dataTransport) {
      this._dataTransport = await createDataTransport({
        proxyNodeIp: this.config.proxyNodeIp,
        proxyPort: this.config.proxyPort,
        requestTimeoutMs: this.config.requestTimeoutMs,
      });
    }
    return this._dataTransport;
  }

  /**
   * POST /execute — run code in the sandbox kernel, streaming the ndjson
   * response into an {@link Execution}. Callbacks fire as events arrive.
   */
  async runCode(code: string, options: RunCodeOptions = {}): Promise<Execution> {
    const transport = await this.dataTransport();
    const execution = new Execution();
    const res = await transport.request({
      method: "POST",
      url: `http://${this.getHost(JUPYTER_PORT)}/execute`,
      headers: {
        "Content-Type": "application/json",
        ...dataHeaders(this, { accessToken: false }),
      },
      body: JSON.stringify({
        code,
        language: options.language ?? null,
        env_vars: options.envs ?? null,
      }),
    });
    if (res.status >= 400) {
      throw new ApiError(`execute failed: HTTP ${res.status}`, res.status);
    }
    for await (const line of iterateNdjsonLines(res.stream())) {
      parseLine(execution, line, options);
    }
    return execution;
  }

  /** POST /sandboxes — create a new sandbox. */
  static async create(options: CreateOptions = {}): Promise<Sandbox> {
    const { data, config } = await this.createRaw(options);
    return new Sandbox(data, config);
  }

  /** POST /sandboxes/:id/connect — connect to (and resume) an existing sandbox. */
  static async connect(sandboxId: string, options: ConnectOptions = {}): Promise<Sandbox> {
    const { data, config } = await this.connectRaw(sandboxId, options);
    return new Sandbox(data, config);
  }

  /** GET /sandboxes/:id — get this sandbox's detail. */
  async getInfo(): Promise<SandboxData> {
    return SandboxApi.getInfo(this.sandboxId, { config: this.config });
  }

  /** DELETE /sandboxes/:id — destroy this sandbox. */
  async kill(): Promise<void> {
    await SandboxApi.kill(this.sandboxId, { config: this.config });
  }

  /**
   * POST /sandboxes/:id/pause — pause this sandbox, preserving its memory
   * snapshot. When `wait` is true (default), polls {@link getInfo} until the
   * state becomes `"paused"`.
   */
  async pause(options: Omit<PauseOptions, "config"> = {}): Promise<void> {
    await SandboxApi.pause(this.sandboxId, { ...options, config: this.config });
  }

  /**
   * POST /sandboxes/:id/resume — resume this sandbox.
   *
   * @deprecated Use {@link Sandbox.connect}, which auto-resumes and returns a
   *   fresh instance.
   */
  async resume(timeout = 300): Promise<void> {
    await SandboxApi.resume(this.sandboxId, timeout, { config: this.config });
  }

  /** POST /sandboxes/:id/snapshots — snapshot this sandbox's current state. */
  async createSnapshot(name?: string): Promise<SnapshotInfo> {
    return SandboxApi.createSnapshot(this.sandboxId, name, { config: this.config });
  }

  /** GET /snapshots — list snapshots of this sandbox (override with `sandboxId`). */
  async listSnapshots(options: Omit<ListSnapshotsOptions, "config"> = {}): Promise<SnapshotPage> {
    return SandboxApi.listSnapshots({ sandboxId: this.sandboxId, ...options, config: this.config });
  }

  /**
   * POST /sandboxes/:id/rollback — revert this sandbox to a snapshot. The VM
   * restarts from the snapshot image, which tears down any open data-plane
   * sockets, so the cached transport is dropped and rebuilt lazily on next use.
   */
  async rollback(snapshotId: string): Promise<Record<string, unknown>> {
    const result = await SandboxApi.rollback(this.sandboxId, snapshotId, { config: this.config });
    await this.close();
    return result;
  }

  /**
   * Clone this sandbox `n` times: snapshot the current state, create `n`
   * sandboxes from it, then delete the ephemeral snapshot. If any create fails,
   * every sibling that already succeeded is killed before the error propagates.
   */
  async clone(n = 1, options: { concurrency?: number } = {}): Promise<Sandbox[]> {
    const concurrency = options.concurrency ?? 1;
    const snapshot = await this.createSnapshot();
    const snapId = snapshot.snapshotId;
    const config = this.config;
    const createOne = () => Sandbox.create({ template: snapId, config });

    const sandboxes: Sandbox[] = [];
    let firstError: unknown;
    try {
      if (concurrency <= 1 || n <= 1) {
        for (let i = 0; i < n; i++) {
          try {
            sandboxes.push(await createOne());
          } catch (e) {
            firstError = e;
            break;
          }
        }
      } else {
        const results = await Promise.allSettled(
          Array.from({ length: n }, () => createOne()),
        );
        for (const r of results) {
          if (r.status === "fulfilled") sandboxes.push(r.value);
          else if (firstError === undefined) firstError = r.reason;
        }
      }
    } finally {
      await Sandbox.deleteSnapshot(snapId, { config }).catch(() => undefined);
    }

    if (firstError !== undefined) {
      await Promise.allSettled(sandboxes.map((sb) => sb.kill()));
      throw firstError;
    }
    return sandboxes;
  }

  /** Release the cached data-plane transport without destroying the sandbox. */
  async close(): Promise<void> {
    if (this._dataTransport) {
      await this._dataTransport.close?.();
      this._dataTransport = undefined;
    }
  }
}
