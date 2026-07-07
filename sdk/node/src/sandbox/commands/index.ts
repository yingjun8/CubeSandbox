// Copyright (c) 2026 Tencent Inc.
// SPDX-License-Identifier: Apache-2.0

// Shell command execution via envd's Process API. E2B drives this with a
// generated ConnectRPC ProcessClient; CubeSandbox speaks the same Connect wire
// format by hand (see ../../envd/connect.ts). Mirrors the Python SDK's
// `_commands.Commands`.

import { ApiError } from "../../errors.js";
import {
  CONNECT_CONTENT_TYPE,
  CONNECT_END_STREAM_FLAG,
  CONNECT_PROTOCOL_VERSION,
  DEFAULT_ENVD_USER,
  ENVD_PORT,
  decodeProcessBytes,
  encodeConnectJson,
  exitCodeFromStatus,
  iterateConnectFrames,
  raiseConnectEndStream,
  userHeaders,
} from "../../envd/connect.js";
import { dataHeaders, type DataPlane } from "../../envd/api.js";

export { Pty, PtyHandle } from "./pty.js";
export type { PtySize, PtyOutput, PtyCreateOptions, PtyConnectOptions } from "./pty.js";

/** The result of a finished command: captured output and its exit code. */
export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Options for {@link Commands.run}. */
export interface CommandRunOptions {
  /** Server-side command timeout in milliseconds (sent as `Connect-Timeout-Ms`). */
  timeoutMs?: number;
  cwd?: string;
  /** Environment variables. `env` is an E2B-compatible alias for `envs`. */
  envs?: Record<string, string>;
  env?: Record<string, string>;
  /** Sandbox user for envd auth. Defaults to `"root"`. */
  user?: string;
}

export class Commands {
  constructor(private readonly dp: DataPlane) {}

  /** Run `cmd` via `/bin/bash -l -c`, returning its stdout, stderr, and exit code. */
  async run(cmd: string, options: CommandRunOptions = {}): Promise<CommandResult> {
    const envs = options.envs ?? options.env ?? {};
    const user = options.user || DEFAULT_ENVD_USER;

    const process: Record<string, unknown> = {
      cmd: "/bin/bash",
      args: ["-l", "-c", cmd],
      envs,
    };
    if (options.cwd) process.cwd = options.cwd;

    const headers: Record<string, string> = {
      "Content-Type": CONNECT_CONTENT_TYPE,
      "Connect-Protocol-Version": CONNECT_PROTOCOL_VERSION,
      "Connect-Content-Encoding": "identity",
      ...dataHeaders(this.dp),
      ...userHeaders(user),
    };
    if (options.timeoutMs != null) {
      headers["Connect-Timeout-Ms"] = String(Math.trunc(options.timeoutMs));
    }

    const transport = await this.dp.dataTransport();
    const res = await transport.request({
      method: "POST",
      url: `http://${this.dp.getHost(ENVD_PORT)}/process.Process/Start`,
      headers,
      body: encodeConnectJson({ process, stdin: false }),
    });

    if (res.status >= 400) {
      const detail = await httpErrorDetail(res);
      throw new ApiError(`command failed: HTTP ${res.status}${detail ? `: ${detail}` : ""}`, res.status);
    }

    return collectProcessStream(res.stream());
  }
}

async function collectProcessStream(stream: AsyncIterable<Uint8Array>): Promise<CommandResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let exitCode: number | null = null;

  for await (const { flags, payload } of iterateConnectFrames(stream)) {
    if (flags & CONNECT_END_STREAM_FLAG) {
      raiseConnectEndStream(payload);
      continue;
    }
    const parsed = JSON.parse(new TextDecoder().decode(payload)) as {
      event?: { data?: { stdout?: string; stderr?: string }; end?: Record<string, unknown> };
    };
    const event = parsed.event ?? {};
    if (event.data?.stdout) stdout.push(decodeProcessBytes(event.data.stdout));
    if (event.data?.stderr) stderr.push(decodeProcessBytes(event.data.stderr));
    const end = event.end;
    if (end != null) {
      if ("exitCode" in end) exitCode = Number(end.exitCode);
      else if ("exit_code" in end) exitCode = Number(end.exit_code);
      else {
        const fromStatus = exitCodeFromStatus(end.status);
        if (fromStatus != null) exitCode = fromStatus;
        else if (end.error) throw new ApiError(`process failed: ${String(end.error)}`);
        else throw new ApiError("process EndEvent missing exit code");
      }
    }
  }

  if (exitCode == null) throw new ApiError("process stream ended without EndEvent");
  return { stdout: stdout.join(""), stderr: stderr.join(""), exitCode };
}

async function httpErrorDetail(res: { text(): Promise<string> }): Promise<string> {
  let text: string;
  try {
    text = (await res.text()).trim();
  } catch {
    return "";
  }
  if (!text) return "";
  try {
    const payload = JSON.parse(text) as Record<string, unknown>;
    const message = (payload.message as string) || ((payload.error as Record<string, unknown>)?.message as string);
    if (typeof message === "string" && message.trim()) return message.trim();
  } catch {
    /* not JSON — fall through to raw text */
  }
  return text;
}
