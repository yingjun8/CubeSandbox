// Copyright (c) 2026 Tencent Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import { Config } from "../src/config.js";
import { TemplateNotFoundError } from "../src/errors.js";
import { Sandbox } from "../src/sandbox/index.js";
import { Template } from "../src/template.js";

const cfg = new Config({ apiUrl: "http://cube.test:3000", sandboxDomain: "cube.app" });

let agent: MockAgent;

beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
});

afterEach(async () => {
  await agent.close();
});

function newSandbox(extra: Record<string, unknown> = {}) {
  return new Sandbox({ sandboxID: "sb-1", templateID: "t", ...extra }, cfg);
}

/** Build a Connect envelope: 1 flag byte + big-endian uint32 length + payload. */
function frame(obj: unknown, flags = 0): Buffer {
  const payload = Buffer.from(JSON.stringify(obj), "utf-8");
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64");

describe("Sandbox.pty", () => {
  it("creates a PTY, streams output, and reports the exit code", async () => {
    let body: Buffer | undefined;
    agent
      .get("http://49983-sb-1.cube.app")
      .intercept({ path: "/process.Process/Start", method: "POST" })
      .reply(200, (opts) => {
        body = Buffer.from(opts.body as any);
        return Buffer.concat([
          frame({ event: { start: { pid: 42 } } }),
          frame({ event: { data: { pty: b64("hello ") } } }),
          frame({ event: { data: { pty: b64("world") } } }),
          frame({ event: { end: { exitCode: 0 } } }),
          frame({}, 0x02),
        ]);
      });

    const sb = newSandbox({ envdAccessToken: "tok" });
    const handle = await sb.pty.create({ rows: 24, cols: 80 });
    expect(handle.pid).toBe(42);

    const chunks: string[] = [];
    const code = await handle.wait((c) => chunks.push(new TextDecoder().decode(c)));
    expect(code).toBe(0);
    expect(chunks.join("")).toBe("hello world");
    expect(handle.exitCode).toBe(0);

    // Request is a Connect envelope wrapping the process + pty config.
    const payload = JSON.parse(body!.subarray(5).toString("utf-8"));
    expect(payload.process.cmd).toBe("/bin/bash");
    expect(payload.process.args).toEqual(["-i", "-l"]);
    expect(payload.process.envs.TERM).toBe("xterm-256color");
    expect(payload.pty.size).toEqual({ rows: 24, cols: 80 });
    await sb.close();
  });

  it("kill returns true on success and false on not_found", async () => {
    const origin = agent.get("http://49983-sb-1.cube.app");
    origin.intercept({ path: "/process.Process/SendSignal", method: "POST" }).reply(200, "{}");
    origin
      .intercept({ path: "/process.Process/SendSignal", method: "POST" })
      .reply(404, JSON.stringify({ code: "not_found" }));
    const sb = newSandbox();
    expect(await sb.pty.kill(42)).toBe(true);
    expect(await sb.pty.kill(99)).toBe(false);
    await sb.close();
  });

  it("sendStdin base64-encodes the input payload", async () => {
    let body: string | undefined;
    agent
      .get("http://49983-sb-1.cube.app")
      .intercept({ path: "/process.Process/SendInput", method: "POST" })
      .reply(200, (opts) => {
        body = opts.body as string;
        return "{}";
      });
    const sb = newSandbox();
    await sb.pty.sendStdin(42, "ls\n");
    expect(JSON.parse(body!)).toEqual({ process: { pid: 42 }, input: { pty: b64("ls\n") } });
    await sb.close();
  });
});

describe("Sandbox snapshots", () => {
  it("createSnapshot returns a SnapshotInfo", async () => {
    agent
      .get("http://cube.test:3000")
      .intercept({ path: "/sandboxes/sb-1/snapshots", method: "POST" })
      .reply(200, { snapshotID: "snap-1", names: ["v1"] });
    const sb = newSandbox();
    const info = await sb.createSnapshot("v1");
    expect(info.snapshotId).toBe("snap-1");
    expect(info.names).toEqual(["v1"]);
  });

  it("listSnapshots parses items and the next-token header", async () => {
    agent
      .get("http://cube.test:3000")
      .intercept({ path: "/snapshots?sandboxID=sb-1", method: "GET" })
      .reply(200, [{ snapshotID: "snap-1" }], { headers: { "x-next-token": "cursor-2" } });
    const sb = newSandbox();
    const page = await sb.listSnapshots();
    expect(page.snapshots.map((s) => s.snapshotId)).toEqual(["snap-1"]);
    expect(page.nextToken).toBe("cursor-2");
  });

  it("rollback posts the snapshot id and drops the cached transport", async () => {
    let body: string | undefined;
    agent
      .get("http://cube.test:3000")
      .intercept({ path: "/sandboxes/sb-1/rollback", method: "POST" })
      .reply(200, (opts) => {
        body = opts.body as string;
        return JSON.stringify({ status: "success" });
      });
    const sb = newSandbox();
    const res = await sb.rollback("snap-1");
    expect(res).toEqual({ status: "success" });
    expect(JSON.parse(body!)).toEqual({ snapshotID: "snap-1" });
  });

  it("clone snapshots, creates n sandboxes, then deletes the snapshot", async () => {
    const origin = agent.get("http://cube.test:3000");
    origin
      .intercept({ path: "/sandboxes/sb-1/snapshots", method: "POST" })
      .reply(200, { snapshotID: "snap-eph", names: [] });
    origin
      .intercept({ path: "/sandboxes", method: "POST" })
      .reply(200, { sandboxID: "sb-clone-1", templateID: "snap-eph" });
    origin.intercept({ path: "/templates/snap-eph", method: "DELETE" }).reply(200, "");
    const sb = newSandbox();
    const clones = await sb.clone(1);
    expect(clones).toHaveLength(1);
    expect(clones[0]!.sandboxId).toBe("sb-clone-1");
  });
});

describe("Template", () => {
  it("build posts an image and returns a TemplateBuild", async () => {
    let body: string | undefined;
    agent
      .get("http://cube.test:3000")
      .intercept({ path: "/templates", method: "POST" })
      .reply(200, (opts) => {
        body = opts.body as string;
        return JSON.stringify({ jobID: "job-1", templateID: "tpl-1", status: "building" });
      });
    const build = await Template.build({ image: "python:3.11-slim", cpuCount: 2, config: cfg });
    expect(build.jobId).toBe("job-1");
    expect(build.templateId).toBe("tpl-1");
    expect(build.status).toBe("building");
    expect(JSON.parse(body!)).toEqual({ image: "python:3.11-slim", cpu: 2 });
  });

  it("build requires an image", async () => {
    await expect(Template.build({ image: "  ", config: cfg })).rejects.toThrow(/image is required/);
  });

  it("list returns TemplateInfo objects", async () => {
    agent
      .get("http://cube.test:3000")
      .intercept({ path: "/templates", method: "GET" })
      .reply(200, [{ templateID: "tpl-1", aliases: ["base"] }]);
    const templates = await Template.list({ config: cfg });
    expect(templates.map((t) => t.templateId)).toEqual(["tpl-1"]);
    expect(templates[0]!.name).toBe("base");
  });

  it("get maps a 404 to TemplateNotFoundError", async () => {
    agent
      .get("http://cube.test:3000")
      .intercept({ path: "/templates/tpl-missing", method: "GET" })
      .reply(404, { message: "no such template" });
    await expect(Template.get("tpl-missing", { config: cfg })).rejects.toThrow(TemplateNotFoundError);
  });

  it("update throws (unsupported by CubeAPI)", () => {
    expect(() => Template.update()).toThrow(/does not support template metadata updates/);
  });
});
