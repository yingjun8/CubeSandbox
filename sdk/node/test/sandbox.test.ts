// Copyright (c) 2026 Tencent Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import { Config } from "../src/config.js";
import {
  ApiError,
  AuthenticationError,
  SandboxNotFoundError,
  TemplateNotFoundError,
} from "../src/errors.js";
import { Sandbox } from "../src/sandbox/index.js";

const ORIGIN = "http://cube.test:3000";
const cfg = new Config({ apiUrl: ORIGIN, sandboxDomain: "cube.app" });

let agent: MockAgent;

beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
});

afterEach(async () => {
  await agent.close();
});

function pool() {
  return agent.get(ORIGIN);
}

describe("Sandbox.create", () => {
  it("builds the base payload and returns a connected sandbox", async () => {
    let seenBody: any;
    pool()
      .intercept({ path: "/sandboxes", method: "POST" })
      .reply(200, (opts) => {
        seenBody = JSON.parse(opts.body as string);
        return { sandboxID: "sb-1", templateID: "tpl-x" };
      });

    const sb = await Sandbox.create({ template: "tpl-x", config: cfg });
    expect(seenBody).toEqual({ templateID: "tpl-x", timeout: 300 });
    expect(sb.sandboxId).toBe("sb-1");
    expect(sb.templateId).toBe("tpl-x");
    expect(sb.getHost(49999)).toBe("49999-sb-1.cube.app");
    await sb.close();
  });

  it("includes envVars, metadata, and allow_internet_access only when set", async () => {
    let body: any;
    pool()
      .intercept({ path: "/sandboxes", method: "POST" })
      .reply(200, (opts) => {
        body = JSON.parse(opts.body as string);
        return { sandboxID: "sb-2", templateID: "tpl" };
      });

    const sb = await Sandbox.create({
      template: "tpl",
      envVars: { A: "1" },
      metadata: { team: "x" },
      allowInternetAccess: false,
      config: cfg,
    });
    expect(body.envVars).toEqual({ A: "1" });
    expect(body.metadata).toEqual({ team: "x" });
    expect(body.allow_internet_access).toBe(false);
    await sb.close();
  });

  it("serializes network rules to camelCase wire shape", async () => {
    let body: any;
    pool()
      .intercept({ path: "/sandboxes", method: "POST" })
      .reply(200, (opts) => {
        body = JSON.parse(opts.body as string);
        return { sandboxID: "sb-3", templateID: "tpl" };
      });

    const sb = await Sandbox.create({
      template: "tpl",
      allowInternetAccess: false,
      network: {
        allowOut: ["example.com"],
        denyOut: ["0.0.0.0/0"],
        allowPublicTraffic: false,
        rules: [
          { name: "r1", match: { host: "api.example.com" }, action: { allow: true } },
        ],
      },
      config: cfg,
    });
    expect(body.network.allowOut).toEqual(["example.com"]);
    expect(body.network.denyOut).toEqual(["0.0.0.0/0"]);
    expect(body.network.allowPublicTraffic).toBe(false);
    expect(body.network.rules[0].name).toBe("r1");
    await sb.close();
  });

  it("converts E2B per-host transforms into inject rules", async () => {
    let body: any;
    pool()
      .intercept({ path: "/sandboxes", method: "POST" })
      .reply(200, (opts) => {
        body = JSON.parse(opts.body as string);
        return { sandboxID: "sb-4", templateID: "tpl" };
      });

    const sb = await Sandbox.create({
      template: "tpl",
      network: {
        rules: { "api.example.com": [{ transform: { headers: { "X-Key": "secret" } } }] },
      },
      config: cfg,
    });
    const rule = body.network.rules[0];
    expect(rule.name).toBe("e2b-transform-api.example.com");
    expect(rule.match).toEqual({ host: "api.example.com" });
    expect(rule.action.allow).toBe(true);
    expect(rule.action.inject[0]).toEqual({ header: "X-Key", secret: "secret" });
    await sb.close();
  });

  it("serializes lifecycle to camelCase", async () => {
    let body: any;
    pool()
      .intercept({ path: "/sandboxes", method: "POST" })
      .reply(200, (opts) => {
        body = JSON.parse(opts.body as string);
        return { sandboxID: "sb-5", templateID: "tpl" };
      });

    const sb = await Sandbox.create({
      template: "tpl",
      lifecycle: { onTimeout: "pause", autoResume: true },
      config: cfg,
    });
    expect(body.lifecycle).toEqual({ onTimeout: "pause", autoResume: true });
    await sb.close();
  });

  it("rejects an invalid lifecycle.onTimeout before any request", async () => {
    await expect(
      Sandbox.create({ template: "tpl", lifecycle: { onTimeout: "paused" as any }, config: cfg }),
    ).rejects.toThrow(/onTimeout/);
  });

  it("throws when no template is provided", async () => {
    await expect(Sandbox.create({ config: cfg })).rejects.toThrow(/template is required/);
  });

  it("rejects allow_out domains without deny-all", async () => {
    await expect(
      Sandbox.create({
        template: "tpl",
        network: { allowOut: ["example.com"] },
        config: cfg,
      }),
    ).rejects.toThrow(ApiError);
  });
});

describe("Sandbox error mapping", () => {
  it("maps 401 to AuthenticationError", async () => {
    pool().intercept({ path: "/sandboxes", method: "POST" }).reply(401, { message: "nope" });
    await expect(Sandbox.create({ template: "t", config: cfg })).rejects.toThrow(AuthenticationError);
  });

  it("maps 404 with 'template' to TemplateNotFoundError", async () => {
    pool()
      .intercept({ path: "/sandboxes", method: "POST" })
      .reply(404, { message: "template missing" });
    await expect(Sandbox.create({ template: "t", config: cfg })).rejects.toThrow(
      TemplateNotFoundError,
    );
  });

  it("maps generic 404 to SandboxNotFoundError", async () => {
    pool()
      .intercept({ path: "/sandboxes/sb-x", method: "GET" })
      .reply(404, { message: "not found" });
    const sb = new Sandbox({ sandboxID: "sb-x", templateID: "t" }, cfg);
    await expect(sb.getInfo()).rejects.toThrow(SandboxNotFoundError);
    await sb.close();
  });
});

describe("Sandbox lifecycle methods", () => {
  it("connect posts timeout and returns a sandbox", async () => {
    let body: any;
    pool()
      .intercept({ path: "/sandboxes/sb-9/connect", method: "POST" })
      .reply(200, (opts) => {
        body = JSON.parse(opts.body as string);
        return { sandboxID: "sb-9", templateID: "t" };
      });
    const sb = await Sandbox.connect("sb-9", { config: cfg });
    expect(body).toEqual({ timeout: 300 });
    expect(sb.sandboxId).toBe("sb-9");
    await sb.close();
  });

  it("kill issues DELETE", async () => {
    pool().intercept({ path: "/sandboxes/sb-k", method: "DELETE" }).reply(200, {});
    const sb = new Sandbox({ sandboxID: "sb-k", templateID: "t" }, cfg);
    await expect(sb.kill()).resolves.toBeUndefined();
    await sb.close();
  });

  it("pause without wait returns after the pause call", async () => {
    pool().intercept({ path: "/sandboxes/sb-p/pause", method: "POST" }).reply(200, {});
    const sb = new Sandbox({ sandboxID: "sb-p", templateID: "t" }, cfg);
    await expect(sb.pause({ wait: false })).resolves.toBeUndefined();
    await sb.close();
  });

  it("pause with wait polls getInfo until paused", async () => {
    pool().intercept({ path: "/sandboxes/sb-w/pause", method: "POST" }).reply(200, {});
    pool()
      .intercept({ path: "/sandboxes/sb-w", method: "GET" })
      .reply(200, { sandboxID: "sb-w", templateID: "t", state: "running" });
    pool()
      .intercept({ path: "/sandboxes/sb-w", method: "GET" })
      .reply(200, { sandboxID: "sb-w", templateID: "t", state: "paused" });
    const sb = new Sandbox({ sandboxID: "sb-w", templateID: "t" }, cfg);
    await expect(sb.pause({ wait: true, timeoutMs: 5_000, intervalMs: 1 })).resolves.toBeUndefined();
    await sb.close();
  });

  it("list returns the raw array", async () => {
    pool()
      .intercept({ path: "/sandboxes", method: "GET" })
      .reply(200, [{ sandboxID: "a", templateID: "t" }]);
    const items = await Sandbox.list({ config: cfg });
    expect(items).toHaveLength(1);
    expect(items[0]!.sandboxID).toBe("a");
  });

  it("health returns the status dict", async () => {
    pool().intercept({ path: "/health", method: "GET" }).reply(200, { status: "ok" });
    expect(await Sandbox.health({ config: cfg })).toEqual({ status: "ok" });
  });
});
