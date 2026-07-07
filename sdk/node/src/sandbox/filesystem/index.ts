// Copyright (c) 2026 Tencent Inc.
// SPDX-License-Identifier: Apache-2.0

// Filesystem access via envd. Plain-file read/write go through the `/files` HTTP
// endpoint; metadata operations use the `filesystem.Filesystem` Connect RPC.
// Mirrors the Python SDK's `_filesystem.Filesystem`.

import { ApiError, FilesystemNotFoundError, PartialWriteError } from "../../errors.js";
import {
  CONNECT_CONTENT_TYPE,
  CONNECT_PROTOCOL_VERSION,
  DEFAULT_ENVD_USER,
  ENVD_PORT,
  encodeConnectJson,
} from "../../envd/connect.js";
import { dataHeaders, type DataPlane } from "../../envd/api.js";
import type { TransportResponse } from "../../transport/types.js";
import { WatchHandle } from "./watchHandle.js";

export { WatchHandle } from "./watchHandle.js";
export type { WatchEvent } from "./watchHandle.js";

/** A directory entry or file/dir metadata record, as returned by envd. */
export type FileEntry = Record<string, unknown>;

/** Options carrying an optional sandbox user. */
export interface FsUserOptions {
  user?: string;
}

export class Filesystem {
  constructor(private readonly dp: DataPlane) {}

  /** Read a file's contents as a UTF-8 string. */
  async read(path: string, options: FsUserOptions = {}): Promise<string> {
    const user = options.user || DEFAULT_ENVD_USER;
    const url = `http://${this.dp.getHost(ENVD_PORT)}/files?${new URLSearchParams({
      path,
      username: user,
    }).toString()}`;
    const transport = await this.dp.dataTransport();
    const res = await transport.request({ method: "GET", url, headers: dataHeaders(this.dp) });
    if (res.status !== 200) {
      throw new ApiError(`Failed to read ${path}: ${await errorMessage(res)}`, res.status);
    }
    return res.text();
  }

  /** Write `data` to a file, retrying via multipart if the octet-stream path is rejected. */
  async write(path: string, data: string | Uint8Array, options: FsUserOptions = {}): Promise<void> {
    const user = options.user || DEFAULT_ENVD_USER;
    const body = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const query = new URLSearchParams({ path, username: user }).toString();
    const url = `http://${this.dp.getHost(ENVD_PORT)}/files?${query}`;
    const transport = await this.dp.dataTransport();

    let res = await transport.request({
      method: "POST",
      url,
      headers: { "Content-Type": "application/octet-stream", ...dataHeaders(this.dp) },
      body,
    });

    if (res.status >= 400) {
      const multipart = encodeMultipart(path, body);
      res = await transport.request({
        method: "POST",
        url,
        headers: { "Content-Type": multipart.contentType, ...dataHeaders(this.dp) },
        body: multipart.body,
      });
    }

    if (res.status >= 400) {
      throw new ApiError(`Failed to write ${path}: ${await errorMessage(res)}`, res.status);
    }
  }

  /**
   * Write multiple files sequentially, stopping at the first failure. On error
   * throws {@link PartialWriteError} carrying the paths written before it.
   */
  async writeFiles(
    files: [path: string, data: string | Uint8Array][],
    options: FsUserOptions = {},
  ): Promise<number> {
    const written: string[] = [];
    for (const [i, [path, data]] of files.entries()) {
      try {
        await this.write(path, data, options);
        written.push(path);
      } catch (e) {
        throw new PartialWriteError(
          `writeFiles failed at ${path} (${i + 1}/${files.length}): ${(e as Error).message}`,
          written,
        );
      }
    }
    return files.length;
  }

  /** List the entries of a directory. */
  async list(path: string): Promise<FileEntry[]> {
    const result = await this.rpc("ListDir", { path });
    return (result.entries as FileEntry[]) ?? [];
  }

  /** Return metadata for a file or directory. */
  async stat(path: string): Promise<FileEntry> {
    const result = await this.rpc("Stat", { path });
    return (result.entry as FileEntry) ?? {};
  }

  /** Return `true` if the path exists inside the sandbox. */
  async exists(path: string): Promise<boolean> {
    try {
      await this.stat(path);
      return true;
    } catch (e) {
      if (e instanceof FilesystemNotFoundError) return false;
      throw e;
    }
  }

  /** Delete a file or directory. */
  async remove(path: string): Promise<void> {
    await this.rpc("Remove", { path });
  }

  /** Move or rename a file or directory, returning the new entry. */
  async rename(oldPath: string, newPath: string): Promise<FileEntry> {
    const result = await this.rpc("Move", { source: oldPath, destination: newPath });
    return (result.entry as FileEntry) ?? {};
  }

  /** Create a directory, returning its entry. */
  async makeDir(path: string): Promise<FileEntry> {
    const result = await this.rpc("MakeDir", { path });
    return (result.entry as FileEntry) ?? {};
  }

  /** Watch a directory for changes, returning an async-iterable handle. */
  async watchDir(path: string): Promise<WatchHandle> {
    const controller = new AbortController();
    const transport = await this.dp.dataTransport();
    const res = await transport.request({
      method: "POST",
      url: `http://${this.dp.getHost(ENVD_PORT)}/filesystem.Filesystem/WatchDir`,
      headers: {
        "Content-Type": CONNECT_CONTENT_TYPE,
        "Connect-Protocol-Version": CONNECT_PROTOCOL_VERSION,
        ...dataHeaders(this.dp),
      },
      body: encodeConnectJson({ path }),
      signal: controller.signal,
    });
    if (res.status >= 400) {
      throw new ApiError(`WatchDir failed: HTTP ${res.status}`, res.status);
    }
    return new WatchHandle(res, controller);
  }

  private async rpc(method: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const transport = await this.dp.dataTransport();
    const res = await transport.request({
      method: "POST",
      url: `http://${this.dp.getHost(ENVD_PORT)}/filesystem.Filesystem/${method}`,
      headers: {
        "Content-Type": "application/json",
        "Connect-Protocol-Version": CONNECT_PROTOCOL_VERSION,
        ...dataHeaders(this.dp),
      },
      body: JSON.stringify(payload),
    });

    if (res.status >= 400) {
      const body = await parseJsonSafe(res);
      const code = (body.code as string) ?? "";
      let message = (body.message as string) || (body.detail as string) || `HTTP ${res.status}`;
      if (code) message = `${code}: ${message}`;
      if (res.status === 404 || code === "not_found") {
        throw new FilesystemNotFoundError(`Filesystem ${method} failed: ${message}`, res.status);
      }
      throw new ApiError(`Filesystem ${method} failed: ${message}`, res.status);
    }

    const text = await res.text();
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  }
}

async function parseJsonSafe(res: TransportResponse): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function errorMessage(res: TransportResponse): Promise<string> {
  const body = await parseJsonSafe(res);
  return (body.message as string) || (body.detail as string) || `HTTP ${res.status}`;
}

/** Encode a single-file `multipart/form-data` body as bytes (runtime-agnostic). */
function encodeMultipart(path: string, body: Uint8Array): { contentType: string; body: Uint8Array } {
  const boundary = `----CubeSandboxBoundary${Math.random().toString(36).slice(2)}`;
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${path}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
  );
  const tail = enc.encode(`\r\n--${boundary}--\r\n`);
  const out = new Uint8Array(head.byteLength + body.byteLength + tail.byteLength);
  out.set(head, 0);
  out.set(body, head.byteLength);
  out.set(tail, head.byteLength + body.byteLength);
  return { contentType: `multipart/form-data; boundary=${boundary}`, body: out };
}
