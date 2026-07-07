// Copyright (c) 2026 Tencent Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import { Config } from "../src/config.js";
import { ApiError, FilesystemNotFoundError, PartialWriteError } from "../src/errors.js";
import { Sandbox } from "../src/sandbox/index.js";

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

describe("Sandbox.runCode", () => {
  it("parses ndjson events into an Execution", async () => {
    let seen: any;
    agent
      .get("http://49999-sb-1.cube.app")
      .intercept({ path: "/execute", method: "POST" })
      .reply(200, (opts) => {
        seen = JSON.parse(opts.body as string);
        return [
          JSON.stringify({ type: "stdout", text: "hi\n" }),
          JSON.stringify({ type: "result", text: "42", is_main_result: true }),
          JSON.stringify({ type: "number_of_executions", execution_count: 3 }),
          "",
        ].join("\n");
      });

    const sb = newSandbox();
    const stdout: string[] = [];
    const exec = await sb.runCode("1+1", { language: "python", onStdout: (m) => stdout.push(m.line) });

    expect(seen).toEqual({ code: "1+1", language: "python", env_vars: null });
    expect(exec.logs.stdout).toEqual(["hi\n"]);
    expect(exec.text).toBe("42");
    expect(exec.executionCount).toBe(3);
    expect(stdout).toEqual(["hi\n"]);
    await sb.close();
  });

  it("throws ApiError on execute HTTP error", async () => {
    agent
      .get("http://49999-sb-1.cube.app")
      .intercept({ path: "/execute", method: "POST" })
      .reply(500, "boom");
    const sb = newSandbox();
    await expect(sb.runCode("x")).rejects.toThrow(ApiError);
    await sb.close();
  });
});

describe("Sandbox.commands", () => {
  it("runs a command and collects stdout/stderr and exit code", async () => {
    let body: Buffer | undefined;
    agent
      .get("http://49983-sb-1.cube.app")
      .intercept({ path: "/process.Process/Start", method: "POST" })
      .reply(200, (opts) => {
        body = Buffer.from(opts.body as any);
        return Buffer.concat([
          frame({ event: { data: { stdout: Buffer.from("out").toString("base64") } } }),
          frame({ event: { data: { stderr: Buffer.from("err").toString("base64") } } }),
          frame({ event: { end: { exitCode: 7 } } }),
          frame({}, 0x02),
        ]);
      });

    const sb = newSandbox({ envdAccessToken: "tok" });
    const res = await sb.commands.run("echo hi", { cwd: "/work" });
    expect(res.stdout).toBe("out");
    expect(res.stderr).toBe("err");
    expect(res.exitCode).toBe(7);

    // Request is a Connect envelope wrapping the process config.
    const payload = JSON.parse(body!.subarray(5).toString("utf-8"));
    expect(payload.process.cmd).toBe("/bin/bash");
    expect(payload.process.args).toEqual(["-l", "-c", "echo hi"]);
    expect(payload.process.cwd).toBe("/work");
    await sb.close();
  });

  it("derives exit code from a status string", async () => {
    agent
      .get("http://49983-sb-1.cube.app")
      .intercept({ path: "/process.Process/Start", method: "POST" })
      .reply(200, () =>
        Buffer.concat([frame({ event: { end: { status: "exit status 2" } } }), frame({}, 0x02)]),
      );
    const sb = newSandbox();
    const res = await sb.commands.run("false");
    expect(res.exitCode).toBe(2);
    await sb.close();
  });

  it("throws ApiError on command HTTP error", async () => {
    agent
      .get("http://49983-sb-1.cube.app")
      .intercept({ path: "/process.Process/Start", method: "POST" })
      .reply(400, JSON.stringify({ message: "bad" }));
    const sb = newSandbox();
    await expect(sb.commands.run("x")).rejects.toThrow(/command failed: HTTP 400: bad/);
    await sb.close();
  });
});

describe("Sandbox.files", () => {
  it("reads a file via the /files endpoint", async () => {
    agent
      .get("http://49983-sb-1.cube.app")
      .intercept({ path: "/files?path=%2Ftmp%2Fa&username=root", method: "GET" })
      .reply(200, "contents");
    const sb = newSandbox();
    expect(await sb.files.read("/tmp/a")).toBe("contents");
    await sb.close();
  });

  it("writes a file with octet-stream", async () => {
    let ct: string | undefined;
    agent
      .get("http://49983-sb-1.cube.app")
      .intercept({ path: "/files?path=%2Ftmp%2Fb&username=root", method: "POST" })
      .reply(200, (opts) => {
        ct = (opts.headers as Record<string, string>)["Content-Type"];
        return "";
      });
    const sb = newSandbox();
    await expect(sb.files.write("/tmp/b", "hello")).resolves.toBeUndefined();
    expect(ct).toBe("application/octet-stream");
    await sb.close();
  });

  it("lists a directory via the Connect RPC", async () => {
    agent
      .get("http://49983-sb-1.cube.app")
      .intercept({ path: "/filesystem.Filesystem/ListDir", method: "POST" })
      .reply(200, { entries: [{ name: "a", type: "file" }] });
    const sb = newSandbox();
    const entries = await sb.files.list("/tmp");
    expect(entries).toEqual([{ name: "a", type: "file" }]);
    await sb.close();
  });

  it("maps 404 stat to FilesystemNotFoundError and exists=false", async () => {
    agent
      .get("http://49983-sb-1.cube.app")
      .intercept({ path: "/filesystem.Filesystem/Stat", method: "POST" })
      .reply(404, { code: "not_found", message: "missing" })
      .times(2);
    const sb = newSandbox();
    await expect(sb.files.stat("/nope")).rejects.toThrow(FilesystemNotFoundError);
    expect(await sb.files.exists("/nope")).toBe(false);
    await sb.close();
  });

  it("writeFiles raises PartialWriteError with paths written so far", async () => {
    const origin = agent.get("http://49983-sb-1.cube.app");
    origin.intercept({ path: "/files?path=%2Fa&username=root", method: "POST" }).reply(200, "");
    // Second file fails on both octet-stream and the multipart fallback.
    origin
      .intercept({ path: "/files?path=%2Fb&username=root", method: "POST" })
      .reply(500, "nope")
      .times(2);
    const sb = newSandbox();
    try {
      await sb.files.writeFiles([
        ["/a", "x"],
        ["/b", "y"],
      ]);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PartialWriteError);
      expect((e as PartialWriteError).written).toEqual(["/a"]);
    }
    await sb.close();
  });
});
