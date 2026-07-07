// Copyright (c) 2026 Tencent Inc.
// SPDX-License-Identifier: Apache-2.0

// Control-plane template management (CubeAPI `/templates`). Class-level helper
// with no live instance required. Mirrors the Python SDK's `_template.Template`.

import { Config, type ConfigOptions } from "./config.js";
import { ApiError, AuthenticationError, TemplateNotFoundError } from "./errors.js";
import { validateAllowOutDomainsRequireDenyAll } from "./sandbox/network.js";
import { resolveConfig, withControl } from "./sandbox/sandboxApi.js";
import type { Transport, TransportResponse } from "./transport/types.js";

/** A template create/rebuild job or build-status record. */
export class TemplateBuild {
  buildId: string;
  status: string;
  templateId: string;
  phase: string;
  progress: number;
  errorMessage: string;
  message: string;
  createdAt: string;
  finishedAt: string;
  logs: string[];

  constructor(init: Partial<TemplateBuild> & { buildId: string; status: string }) {
    this.buildId = init.buildId;
    this.status = init.status;
    this.templateId = init.templateId ?? "";
    this.phase = init.phase ?? "";
    this.progress = init.progress ?? 0;
    this.errorMessage = init.errorMessage ?? "";
    this.message = init.message ?? "";
    this.createdAt = init.createdAt ?? "";
    this.finishedAt = init.finishedAt ?? "";
    this.logs = init.logs ?? [];
  }

  /** Alias for create/rebuild responses that use `jobID`. */
  get jobId(): string {
    return this.buildId;
  }

  static fromDict(data: Record<string, unknown>): TemplateBuild {
    return new TemplateBuild({
      buildId: str(data.buildID ?? data.jobID ?? data.build_id),
      templateId: str(data.templateID ?? data.template_id),
      status: str(data.status),
      phase: str(data.phase),
      progress: num(data.progress),
      errorMessage: str(data.errorMessage ?? data.error_message),
      message: str(data.message),
      createdAt: str(data.createdAt ?? data.created_at),
      finishedAt: str(data.finishedAt ?? data.finished_at),
      logs: (data.logs as string[]) ?? [],
    });
  }
}

/** Metadata for a CubeSandbox template. */
export class TemplateInfo {
  templateId: string;
  name: string;
  instanceType: string;
  version: string;
  status: string;
  lastError: string;
  createdAt: string;
  imageInfo: string;
  jobId: string;
  public: boolean;
  cpuCount: number;
  memoryMb: number;
  replicas: Record<string, unknown>[];
  createRequest?: Record<string, unknown>;
  networkType?: string;
  allowInternetAccess?: boolean;
  builds: TemplateBuild[];

  constructor(init: Partial<TemplateInfo> & { templateId: string }) {
    this.templateId = init.templateId;
    this.name = init.name ?? "";
    this.instanceType = init.instanceType ?? "";
    this.version = init.version ?? "";
    this.status = init.status ?? "";
    this.lastError = init.lastError ?? "";
    this.createdAt = init.createdAt ?? "";
    this.imageInfo = init.imageInfo ?? "";
    this.jobId = init.jobId ?? "";
    this.public = init.public ?? false;
    this.cpuCount = init.cpuCount ?? 0;
    this.memoryMb = init.memoryMb ?? 0;
    this.replicas = init.replicas ?? [];
    this.createRequest = init.createRequest;
    this.networkType = init.networkType;
    this.allowInternetAccess = init.allowInternetAccess;
    this.builds = init.builds ?? [];
  }

  static fromDict(data: Record<string, unknown>): TemplateInfo {
    const aliases = (data.aliases as string[]) ?? [];
    const allowInternet =
      "allowInternetAccess" in data ? data.allowInternetAccess : data.allow_internet_access;
    return new TemplateInfo({
      templateId: str(data.templateID ?? data.template_id),
      name: str(data.name) || (aliases[0] ?? ""),
      instanceType: str(data.instanceType ?? data.instance_type),
      version: str(data.version),
      status: str(data.status),
      lastError: str(data.lastError ?? data.last_error),
      createdAt: str(data.createdAt ?? data.created_at),
      imageInfo: str(data.imageInfo ?? data.image_info),
      jobId: str(data.jobID ?? data.job_id),
      public: Boolean(data.public ?? false),
      cpuCount: num(data.cpuCount ?? data.cpu_count),
      memoryMb: num(data.memoryMB ?? data.memory_mb),
      replicas: (data.replicas as Record<string, unknown>[]) ?? [],
      createRequest: (data.createRequest ?? data.create_request) as Record<string, unknown> | undefined,
      networkType: (data.networkType ?? data.network_type) as string | undefined,
      allowInternetAccess: allowInternet == null ? undefined : Boolean(allowInternet),
      builds: ((data.builds as Record<string, unknown>[]) ?? []).map((b) => TemplateBuild.fromDict(b)),
    });
  }
}

/** Options for {@link Template.build}. */
export interface TemplateBuildOptions {
  image: string;
  instanceType?: string;
  writableLayerSize?: string;
  exposedPorts?: number[];
  probePort?: number;
  probePath?: string;
  cpuCount?: number;
  memoryMb?: number;
  envs?: Record<string, string>;
  allowInternetAccess?: boolean;
  networkType?: string;
  nodes?: string[];
  registryUsername?: string;
  registryPassword?: string;
  command?: string[];
  args?: string[];
  dns?: string[];
  allowOut?: string[];
  denyOut?: string[];
  /** Extra fields forwarded verbatim to the request body. */
  extra?: Record<string, unknown>;
  config?: Config | ConfigOptions;
}

/** Options for control-plane template methods that only need a config. */
export interface TemplateConfigOptions {
  config?: Config | ConfigOptions;
}

/** Options for {@link Template.get}. */
export interface TemplateGetOptions extends TemplateConfigOptions {
  limit?: number;
  nextToken?: string;
}

/**
 * Class-level helper for Cube template management. All methods are static — no
 * instance required.
 */
export class Template {
  private constructor() {}

  /** GET /templates — list all templates. */
  static async list(options: TemplateConfigOptions = {}): Promise<TemplateInfo[]> {
    const config = resolveConfig(options.config);
    return withControl(config, async (t) => {
      const res = await templateRequest(t, config, "GET", "/templates");
      let data = (await res.json()) as Record<string, unknown>[] | Record<string, unknown> | null;
      if (data && !Array.isArray(data)) {
        data = ((data.templates ?? data.items) as Record<string, unknown>[]) ?? [];
      }
      return ((data as Record<string, unknown>[]) ?? []).map((d) => TemplateInfo.fromDict(d));
    });
  }

  /** GET /templates/:id — get a template and its build history. */
  static async get(templateId: string, options: TemplateGetOptions = {}): Promise<TemplateInfo> {
    const config = resolveConfig(options.config);
    const params = new URLSearchParams();
    if (options.limit != null) params.set("limit", String(options.limit));
    if (options.nextToken != null) params.set("nextToken", options.nextToken);
    const qs = params.toString();
    return withControl(config, async (t) => {
      const res = await templateRequest(t, config, "GET", `/templates/${templateId}${qs ? `?${qs}` : ""}`);
      return TemplateInfo.fromDict((await res.json()) as Record<string, unknown>);
    });
  }

  /** POST /templates — build (create) a new template from a container image. */
  static async build(options: TemplateBuildOptions): Promise<TemplateBuild> {
    const image = options.image?.trim();
    if (!image) throw new Error("image is required");
    validateAllowOutDomainsRequireDenyAll(
      options.allowOut,
      options.denyOut,
      options.allowInternetAccess === false,
    );

    const config = resolveConfig(options.config);
    const payload: Record<string, unknown> = { image };
    if (options.instanceType != null) payload.instanceType = options.instanceType;
    if (options.writableLayerSize != null) payload.writableLayerSize = options.writableLayerSize;
    if (options.exposedPorts != null) payload.exposedPorts = options.exposedPorts;
    if (options.probePort != null) payload.probePort = options.probePort;
    if (options.probePath != null) payload.probePath = options.probePath;
    if (options.cpuCount != null) payload.cpu = options.cpuCount;
    if (options.memoryMb != null) payload.memory = options.memoryMb;
    if (options.envs != null) {
      payload.env = Object.entries(options.envs).map(([k, v]) => `${k}=${v}`);
    }
    if (options.allowInternetAccess != null) payload.allowInternetAccess = options.allowInternetAccess;
    if (options.networkType != null) payload.networkType = options.networkType;
    if (options.nodes != null) payload.nodes = options.nodes;
    if (options.registryUsername != null) payload.registryUsername = options.registryUsername;
    if (options.registryPassword != null) payload.registryPassword = options.registryPassword;
    if (options.command != null) payload.command = options.command;
    if (options.args != null) payload.args = options.args;
    if (options.dns != null) payload.dns = options.dns;
    if (options.allowOut != null) payload.allowOut = options.allowOut;
    if (options.denyOut != null) payload.denyOut = options.denyOut;
    if (options.extra) Object.assign(payload, options.extra);

    return withControl(config, async (t) => {
      const res = await templateRequest(t, config, "POST", "/templates", payload);
      return TemplateBuild.fromDict((await res.json()) as Record<string, unknown>);
    });
  }

  /** POST /templates/:id — rebuild an existing template. */
  static async rebuild(
    templateId: string,
    options: TemplateConfigOptions & { extra?: Record<string, unknown> } = {},
  ): Promise<TemplateBuild> {
    const config = resolveConfig(options.config);
    return withControl(config, async (t) => {
      const res = await templateRequest(t, config, "POST", `/templates/${templateId}`, options.extra ?? {});
      return TemplateBuild.fromDict((await res.json()) as Record<string, unknown>);
    });
  }

  /** GET /templates/:id/builds/:buildId/status — poll a build's status. */
  static async getBuildStatus(
    templateId: string,
    buildId: string,
    options: TemplateConfigOptions = {},
  ): Promise<TemplateBuild> {
    const config = resolveConfig(options.config);
    return withControl(config, async (t) => {
      const res = await templateRequest(
        t,
        config,
        "GET",
        `/templates/${templateId}/builds/${buildId}/status`,
      );
      return TemplateBuild.fromDict((await res.json()) as Record<string, unknown>);
    });
  }

  /** GET /templates/:id/builds/:buildId/logs — fetch a build's logs. */
  static async getBuildLogs(
    templateId: string,
    buildId: string,
    options: TemplateConfigOptions = {},
  ): Promise<Record<string, unknown>> {
    const config = resolveConfig(options.config);
    return withControl(config, async (t) => {
      const res = await templateRequest(
        t,
        config,
        "GET",
        `/templates/${templateId}/builds/${buildId}/logs`,
      );
      return (await res.json()) as Record<string, unknown>;
    });
  }

  /**
   * Template metadata updates are not supported by CubeAPI. Use {@link rebuild}
   * or delete and recreate the template.
   */
  static update(): never {
    throw new Error(
      "CubeAPI does not support template metadata updates; use Template.rebuild() " +
        "or delete and recreate the template",
    );
  }

  /** DELETE /templates/:id — delete a template (or snapshot) permanently. */
  static async delete(templateId: string, options: TemplateConfigOptions = {}): Promise<void> {
    const config = resolveConfig(options.config);
    await withControl(config, async (t) => {
      const res = await templateRequest(t, config, "DELETE", `/templates/${templateId}`);
      await res.text().catch(() => undefined);
    });
  }
}

/** Issue a template request, mapping errors: 401/403→Auth, 404→TemplateNotFound, else Api. */
async function templateRequest(
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
  if (res.status < 400) return res;

  let msg: string;
  try {
    const b = (await res.json()) as Record<string, unknown>;
    msg = (b.message as string) || (b.detail as string) || JSON.stringify(b);
  } catch {
    msg = (await res.text().catch(() => "")) || `HTTP ${res.status}`;
  }
  const code = res.status;
  if (code === 401 || code === 403) throw new AuthenticationError(msg, code);
  if (code === 404) throw new TemplateNotFoundError(msg, code);
  throw new ApiError(msg, code);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function num(v: unknown): number {
  return typeof v === "number" ? v : v == null ? 0 : Number(v) || 0;
}
