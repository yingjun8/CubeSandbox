// Copyright (c) 2026 Tencent Inc.
// SPDX-License-Identifier: Apache-2.0

import { getEnvVar } from "./runtime.js";

/** User-supplied overrides for {@link Config}. All fields optional. */
export interface ConfigOptions {
  apiUrl?: string;
  apiKey?: string;
  templateId?: string;
  proxyNodeIp?: string;
  proxyPort?: number;
  sandboxDomain?: string;
  /** Default sandbox lifetime in seconds. */
  timeout?: number;
  /** Per-request timeout in milliseconds. */
  requestTimeoutMs?: number;
}

const DEFAULT_API_URL = "http://127.0.0.1:3000";
const DEFAULT_PROXY_PORT = 80;
const DEFAULT_SANDBOX_DOMAIN = "cube.app";
const DEFAULT_TIMEOUT = 300;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

function envInt(name: string): number | undefined {
  const raw = getEnvVar(name);
  if (raw == null || raw === "") return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? undefined : n;
}

/**
 * Resolved SDK configuration. Values come from explicit options first, then
 * environment variables, then built-in defaults.
 *
 * E2B compatibility: `CUBE_API_URL` falls back to `E2B_API_URL`, and the API
 * key is read from either `CUBE_API_KEY` or `E2B_API_KEY`. This lets existing
 * E2B-configured environments talk to CubeSandbox without re-keying.
 */
export class Config {
  readonly apiUrl: string;
  readonly apiKey?: string;
  readonly templateId?: string;
  readonly proxyNodeIp?: string;
  readonly proxyPort: number;
  readonly sandboxDomain: string;
  readonly timeout: number;
  readonly requestTimeoutMs: number;

  constructor(options: ConfigOptions = {}) {
    const apiUrl =
      options.apiUrl ??
      getEnvVar("CUBE_API_URL") ??
      getEnvVar("E2B_API_URL") ??
      DEFAULT_API_URL;
    // Strip trailing slashes so `${apiUrl}/sandboxes` never double-slashes.
    this.apiUrl = apiUrl.replace(/\/+$/, "");

    this.apiKey =
      options.apiKey ?? getEnvVar("CUBE_API_KEY") ?? getEnvVar("E2B_API_KEY");

    this.templateId = options.templateId ?? getEnvVar("CUBE_TEMPLATE_ID");

    this.proxyNodeIp = options.proxyNodeIp ?? getEnvVar("CUBE_PROXY_NODE_IP");

    this.proxyPort =
      options.proxyPort ?? envInt("CUBE_PROXY_PORT_HTTP") ?? DEFAULT_PROXY_PORT;

    this.sandboxDomain =
      options.sandboxDomain ??
      getEnvVar("CUBE_SANDBOX_DOMAIN") ??
      DEFAULT_SANDBOX_DOMAIN;

    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;

    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }
}
