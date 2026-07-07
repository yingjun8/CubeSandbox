// Copyright (c) 2026 Tencent Inc.
// SPDX-License-Identifier: Apache-2.0

// Control-plane surface (CubeAPI JSON REST). Mirrors E2B's `SandboxApi` base
// class: static, id-based operations that don't require a live `Sandbox`
// instance. `Sandbox` extends this and adds instance methods + the data plane.

import { Config, type ConfigOptions } from "../config.js";
import {
  ApiError,
  AuthenticationError,
  SandboxNotFoundError,
  TemplateNotFoundError,
} from "../errors.js";
import {
  normalizeRulesArg,
  serializeRule,
  validateAllowOutDomainsRequireDenyAll,
  type Rule,
  type RuleDict,
} from "./network.js";
import { createControlTransport } from "../transport/index.js";
import type { Transport, TransportResponse } from "../transport/types.js";
import { SnapshotInfo } from "../models.js";

/** Raw sandbox metadata as returned by the CubeAPI control plane. */
export interface SandboxData {
  sandboxID: string;
  templateID: string;
  domain?: string;
  trafficAccessToken?: string;
  envdAccessToken?: string;
  state?: string;
  [key: string]: unknown;
}

/** Egress network policy. `rules` accepts CubeEgress rules or E2B per-host transforms. */
export interface NetworkPolicy {
  allowOut?: string[];
  denyOut?: string[];
  allowPublicTraffic?: boolean;
  rules?: (Rule | RuleDict)[] | Record<string, unknown>;
}

/** Idle lifecycle behaviour, mirroring E2B's `lifecycle` object. */
export interface Lifecycle {
  onTimeout?: "kill" | "pause";
  autoResume?: boolean;
}

/** Options for {@link Sandbox.create}. */
export interface CreateOptions {
  template?: string;
  timeout?: number;
  envVars?: Record<string, string>;
  metadata?: Record<string, string>;
  allowInternetAccess?: boolean;
  network?: NetworkPolicy;
  lifecycle?: Lifecycle;
  config?: Config | ConfigOptions;
}

/** Options for control-plane methods that only need a config. */
export interface ConnectOptions {
  config?: Config | ConfigOptions;
}

/** Options for {@link Sandbox.pause}. */
export interface PauseOptions extends ConnectOptions {
  wait?: boolean;
  timeoutMs?: number;
  intervalMs?: number;
}

/** Options for {@link SandboxApi.listSnapshots}. */
export interface ListSnapshotsOptions extends ConnectOptions {
  /** Filter by the source sandbox ID. */
  sandboxId?: string;
  /** Page size (server default when omitted). */
  limit?: number;
  /** Pagination cursor from a previous call. */
  nextToken?: string;
}

/** A page of snapshots plus the cursor for the next page (if any). */
export interface SnapshotPage {
  snapshots: SnapshotInfo[];
  nextToken?: string;
}

export function resolveConfig(config?: Config | ConfigOptions): Config {
  if (config instanceof Config) return config;
  return new Config(config);
}

const VALID_ON_TIMEOUT: ReadonlyArray<string> = ["kill", "pause"];

function serializeLifecycle(lifecycle: Lifecycle): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (lifecycle.onTimeout != null) {
    if (!VALID_ON_TIMEOUT.includes(lifecycle.onTimeout)) {
      throw new Error(
        `lifecycle.onTimeout must be one of ${JSON.stringify(VALID_ON_TIMEOUT)}, ` +
          `got ${JSON.stringify(lifecycle.onTimeout)}`,
      );
    }
    out.onTimeout = lifecycle.onTimeout;
  }
  if ("autoResume" in lifecycle && lifecycle.autoResume !== undefined) {
    out.autoResume = Boolean(lifecycle.autoResume);
  }
  return out;
}

/** Map a failed control-plane response to a typed error. Consumes the body. */
async function checkResponse(res: TransportResponse): Promise<void> {
  if (res.status < 400) return;
  let msg: string;
  try {
    const body = (await res.json()) as Record<string, unknown>;
    msg = (body.message as string) || (body.detail as string) || JSON.stringify(body);
  } catch {
    try {
      msg = (await res.text()) || `HTTP ${res.status}`;
    } catch {
      msg = `HTTP ${res.status}`;
    }
  }
  const code = res.status;
  if (code === 401 || code === 403) throw new AuthenticationError(msg, code);
  if (code === 404) {
    throw msg.toLowerCase().includes("template")
      ? new TemplateNotFoundError(msg, code)
      : new SandboxNotFoundError(msg, code);
  }
  throw new ApiError(msg, code);
}

/** Issue a control-plane request over `transport`, mapping errors. */
export async function controlRequest(
  transport: Transport,
  config: Config,
  method: string,
  path: string,
  body?: unknown,
): Promise<TransportResponse> {
  const headers: Record<string, string> = {};
  let bodyStr: string | undefined;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    bodyStr = JSON.stringify(body);
  }
  const res = await transport.request({
    method,
    url: `${config.apiUrl}${path}`,
    headers,
    body: bodyStr,
    timeoutMs: config.requestTimeoutMs,
  });
  await checkResponse(res);
  return res;
}

/** Run `fn` with a short-lived control transport, always closing it. */
export async function withControl<T>(config: Config, fn: (t: Transport) => Promise<T>): Promise<T> {
  const transport = createControlTransport(config.requestTimeoutMs);
  try {
    return await fn(transport);
  } finally {
    await transport.close?.();
  }
}

/** Assemble the POST /sandboxes request body from create options. */
function buildCreatePayload(cfg: Config, options: CreateOptions): Record<string, unknown> {
  const tpl = options.template ?? cfg.templateId;
  if (!tpl) {
    throw new Error("template is required. Set CUBE_TEMPLATE_ID or pass template.");
  }

  const payload: Record<string, unknown> = {
    templateID: tpl,
    timeout: options.timeout ?? cfg.timeout,
  };
  if (options.envVars) payload.envVars = options.envVars;
  if (options.metadata) payload.metadata = options.metadata;
  const allowInternet = options.allowInternetAccess ?? true;
  if (!allowInternet) payload.allow_internet_access = false;

  if (options.network) {
    const n = options.network;
    validateAllowOutDomainsRequireDenyAll(n.allowOut, n.denyOut, !allowInternet);
    const net: Record<string, unknown> = {};
    if (n.allowOut !== undefined) net.allowOut = n.allowOut;
    if (n.denyOut !== undefined) net.denyOut = n.denyOut;
    if (n.allowPublicTraffic !== undefined) net.allowPublicTraffic = n.allowPublicTraffic;
    if (n.rules) {
      const normalized = normalizeRulesArg(n.rules);
      if (normalized.length > 0) net.rules = normalized.map(serializeRule);
    }
    if (Object.keys(net).length > 0) payload.network = net;
  }

  if (options.lifecycle) payload.lifecycle = serializeLifecycle(options.lifecycle);
  return payload;
}

/**
 * Static, id-based control-plane operations. `Sandbox` extends this class so the
 * same operations are reachable both statically (`Sandbox.kill(id)`) and via a
 * live instance (`sb.kill()`), matching the E2B SDK ergonomics.
 */
export class SandboxApi {
  protected constructor() {}

  /** POST /sandboxes — create a sandbox, returning raw metadata + resolved config. */
  protected static async createRaw(
    options: CreateOptions = {},
  ): Promise<{ data: SandboxData; config: Config }> {
    const config = resolveConfig(options.config);
    const payload = buildCreatePayload(config, options);
    const data = await withControl(config, async (t) => {
      const res = await controlRequest(t, config, "POST", "/sandboxes", payload);
      return (await res.json()) as SandboxData;
    });
    return { data, config };
  }

  /** POST /sandboxes/:id/connect — connect to (and resume) a sandbox. */
  protected static async connectRaw(
    sandboxId: string,
    options: ConnectOptions = {},
  ): Promise<{ data: SandboxData; config: Config }> {
    const config = resolveConfig(options.config);
    const data = await withControl(config, async (t) => {
      const res = await controlRequest(t, config, "POST", `/sandboxes/${sandboxId}/connect`, {
        timeout: config.timeout,
      });
      return (await res.json()) as SandboxData;
    });
    return { data, config };
  }

  /** GET /sandboxes — list running sandboxes (v1). */
  static async list(options: ConnectOptions = {}): Promise<SandboxData[]> {
    const config = resolveConfig(options.config);
    return withControl(config, async (t) => {
      const res = await controlRequest(t, config, "GET", "/sandboxes");
      return (await res.json()) as SandboxData[];
    });
  }

  /** GET /v2/sandboxes — list running sandboxes (v2, server-side filtering). */
  static async listV2(options: ConnectOptions = {}): Promise<SandboxData[]> {
    const config = resolveConfig(options.config);
    return withControl(config, async (t) => {
      const res = await controlRequest(t, config, "GET", "/v2/sandboxes");
      return (await res.json()) as SandboxData[];
    });
  }

  /** GET /health — check CubeAPI service health. */
  static async health(options: ConnectOptions = {}): Promise<Record<string, unknown>> {
    const config = resolveConfig(options.config);
    return withControl(config, async (t) => {
      const res = await controlRequest(t, config, "GET", "/health");
      return (await res.json()) as Record<string, unknown>;
    });
  }

  /** GET /sandboxes/:id — fetch sandbox detail. */
  static async getInfo(sandboxId: string, options: ConnectOptions = {}): Promise<SandboxData> {
    const config = resolveConfig(options.config);
    return withControl(config, async (t) => {
      const res = await controlRequest(t, config, "GET", `/sandboxes/${sandboxId}`);
      return (await res.json()) as SandboxData;
    });
  }

  /** DELETE /sandboxes/:id — destroy a sandbox. */
  static async kill(sandboxId: string, options: ConnectOptions = {}): Promise<void> {
    const config = resolveConfig(options.config);
    await withControl(config, async (t) => {
      const res = await controlRequest(t, config, "DELETE", `/sandboxes/${sandboxId}`);
      await res.text().catch(() => undefined);
    });
  }

  /**
   * POST /sandboxes/:id/pause — pause a sandbox. When `wait` is true (default),
   * polls {@link getInfo} until the state becomes `"paused"`.
   */
  static async pause(sandboxId: string, options: PauseOptions = {}): Promise<void> {
    const { wait = true, timeoutMs = 30_000, intervalMs = 1_000 } = options;
    const config = resolveConfig(options.config);
    await withControl(config, async (t) => {
      const res = await controlRequest(t, config, "POST", `/sandboxes/${sandboxId}/pause`);
      await res.text().catch(() => undefined);
    });
    if (!wait) return;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await this.getInfo(sandboxId, { config })).state === "paused") return;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(
      `Sandbox '${sandboxId}' did not reach 'paused' state within ${timeoutMs}ms`,
    );
  }

  /**
   * POST /sandboxes/:id/snapshots — create a snapshot. The sandbox is briefly
   * paused during capture; the snapshot outlives the sandbox. `name` optionally
   * attaches the build to an existing template of that name.
   */
  static async createSnapshot(
    sandboxId: string,
    name?: string,
    options: ConnectOptions = {},
  ): Promise<SnapshotInfo> {
    const config = resolveConfig(options.config);
    const payload: Record<string, unknown> = {};
    if (name != null) payload.name = name;
    return withControl(config, async (t) => {
      const res = await controlRequest(
        t,
        config,
        "POST",
        `/sandboxes/${sandboxId}/snapshots`,
        payload,
      );
      return SnapshotInfo.fromDict((await res.json()) as Record<string, unknown>);
    });
  }

  /**
   * POST /sandboxes/:id/rollback — revert a sandbox's filesystem and memory to
   * a snapshot. The sandbox process restarts from the snapshot image.
   */
  static async rollback(
    sandboxId: string,
    snapshotId: string,
    options: ConnectOptions = {},
  ): Promise<Record<string, unknown>> {
    const config = resolveConfig(options.config);
    return withControl(config, async (t) => {
      const res = await controlRequest(t, config, "POST", `/sandboxes/${sandboxId}/rollback`, {
        snapshotID: snapshotId,
      });
      return (await res.json()) as Record<string, unknown>;
    });
  }

  /**
   * GET /snapshots — list snapshots, returning a page plus an optional
   * `nextToken` cursor (from the `x-next-token` response header).
   */
  static async listSnapshots(options: ListSnapshotsOptions = {}): Promise<SnapshotPage> {
    const config = resolveConfig(options.config);
    const params = new URLSearchParams();
    if (options.sandboxId != null) params.set("sandboxID", options.sandboxId);
    if (options.limit != null) params.set("limit", String(options.limit));
    if (options.nextToken != null) params.set("nextToken", options.nextToken);
    const qs = params.toString();
    return withControl(config, async (t) => {
      const res = await controlRequest(t, config, "GET", `/snapshots${qs ? `?${qs}` : ""}`);
      const items = ((await res.json()) as Record<string, unknown>[] | null) ?? [];
      const snapshots = items.map((d) => SnapshotInfo.fromDict(d));
      const nextToken = res.headers.get("x-next-token") || undefined;
      return { snapshots, nextToken };
    });
  }

  /**
   * DELETE /templates/:snapshotID — delete a snapshot. Snapshots are stored as
   * templates, so this removes the underlying template permanently.
   */
  static async deleteSnapshot(snapshotId: string, options: ConnectOptions = {}): Promise<void> {
    const config = resolveConfig(options.config);
    await withControl(config, async (t) => {
      const res = await controlRequest(t, config, "DELETE", `/templates/${snapshotId}`);
      await res.text().catch(() => undefined);
    });
  }

  /**
   * POST /sandboxes/:id/resume — resume a paused sandbox.
   *
   * @deprecated Use {@link Sandbox.connect}, which auto-resumes and returns a
   *   fresh instance.
   */
  static async resume(
    sandboxId: string,
    timeout = 300,
    options: ConnectOptions = {},
  ): Promise<void> {
    const config = resolveConfig(options.config);
    await withControl(config, async (t) => {
      const res = await controlRequest(t, config, "POST", `/sandboxes/${sandboxId}/resume`, {
        timeout,
      });
      await res.text().catch(() => undefined);
    });
  }
}
