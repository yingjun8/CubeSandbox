// Copyright (c) 2026 Tencent Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Config } from "../src/config.js";

const ENV_KEYS = [
  "CUBE_API_URL", "E2B_API_URL", "CUBE_API_KEY", "E2B_API_KEY",
  "CUBE_TEMPLATE_ID", "CUBE_PROXY_NODE_IP", "CUBE_PROXY_PORT_HTTP",
  "CUBE_SANDBOX_DOMAIN",
];

describe("Config", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("uses built-in defaults with no env or options", () => {
    const c = new Config();
    expect(c.apiUrl).toBe("http://127.0.0.1:3000");
    expect(c.proxyPort).toBe(80);
    expect(c.sandboxDomain).toBe("cube.app");
    expect(c.timeout).toBe(300);
    expect(c.requestTimeoutMs).toBe(30_000);
    expect(c.apiKey).toBeUndefined();
    expect(c.proxyNodeIp).toBeUndefined();
  });

  it("strips trailing slashes from apiUrl", () => {
    expect(new Config({ apiUrl: "http://host:3000/" }).apiUrl).toBe("http://host:3000");
    expect(new Config({ apiUrl: "http://host:3000///" }).apiUrl).toBe("http://host:3000");
  });

  it("options take precedence over env", () => {
    process.env.CUBE_API_URL = "http://from-env:1";
    expect(new Config({ apiUrl: "http://from-opt:2" }).apiUrl).toBe("http://from-opt:2");
  });

  it("falls back to E2B_API_URL when CUBE_API_URL is unset", () => {
    process.env.E2B_API_URL = "http://e2b-host:9";
    expect(new Config().apiUrl).toBe("http://e2b-host:9");
  });

  it("prefers CUBE_API_URL over E2B_API_URL", () => {
    process.env.CUBE_API_URL = "http://cube-host:8";
    process.env.E2B_API_URL = "http://e2b-host:9";
    expect(new Config().apiUrl).toBe("http://cube-host:8");
  });

  it("reads api key from either CUBE_API_KEY or E2B_API_KEY", () => {
    process.env.E2B_API_KEY = "e2b-key";
    expect(new Config().apiKey).toBe("e2b-key");
    process.env.CUBE_API_KEY = "cube-key";
    expect(new Config().apiKey).toBe("cube-key");
  });

  it("parses proxy port from env", () => {
    process.env.CUBE_PROXY_PORT_HTTP = "8080";
    expect(new Config().proxyPort).toBe(8080);
  });

  it("ignores a non-numeric proxy port env, falling back to default", () => {
    process.env.CUBE_PROXY_PORT_HTTP = "not-a-number";
    expect(new Config().proxyPort).toBe(80);
  });
});
