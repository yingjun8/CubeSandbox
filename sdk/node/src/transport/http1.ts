// Copyright (c) 2026 Tencent Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal HTTP/1.1 client over a raw byte-duplex socket. Used by runtimes that
 * expose raw TCP (Deno via `Deno.connect`, Cloudflare via `cloudflare:sockets`)
 * but no way to make `fetch` connect-to-IP-while-preserving-Host.
 *
 * Supports both `Transfer-Encoding: chunked` and read-until-EOF bodies, which
 * covers CubeSandbox's ndjson (`/execute`) and Connect-framed streams.
 */

export interface RawSocket {
  write(data: Uint8Array): Promise<void>;
  read(): AsyncIterator<Uint8Array>;
  close(): void;
}

export interface Http1Request {
  method: string;
  path: string;
  host: string;
  headers?: Record<string, string>;
  body?: Uint8Array;
}

export interface Http1Response {
  status: number;
  headers: Headers;
  stream: AsyncIterable<Uint8Array>;
}

const CRLF = "\r\n";
const encoder = new TextEncoder();

function encodeRequest(req: Http1Request): Uint8Array {
  const lines = [`${req.method} ${req.path} HTTP/1.1`, `Host: ${req.host}`, "Connection: close"];
  const headers = req.headers ?? {};
  const lowerKeys = new Set(Object.keys(headers).map((k) => k.toLowerCase()));
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "host" || k.toLowerCase() === "connection") continue;
    lines.push(`${k}: ${v}`);
  }
  if (req.body && !lowerKeys.has("content-length")) {
    lines.push(`Content-Length: ${req.body.byteLength}`);
  }
  const head = encoder.encode(lines.join(CRLF) + CRLF + CRLF);
  if (!req.body || req.body.byteLength === 0) return head;
  const out = new Uint8Array(head.byteLength + req.body.byteLength);
  out.set(head, 0);
  out.set(req.body, head.byteLength);
  return out;
}

/** Pull-based byte reader with line/count primitives over a socket iterator. */
class ByteReader {
  private buf = new Uint8Array(0);
  private done = false;

  constructor(private readonly it: AsyncIterator<Uint8Array>) {}

  private append(chunk: Uint8Array): void {
    const next = new Uint8Array(this.buf.byteLength + chunk.byteLength);
    next.set(this.buf, 0);
    next.set(chunk, this.buf.byteLength);
    this.buf = next;
  }

  private async pull(): Promise<boolean> {
    if (this.done) return false;
    const { value, done } = await this.it.next();
    if (done) {
      this.done = true;
      return false;
    }
    if (value && value.byteLength) this.append(value);
    return true;
  }

  /** Read up to and including the next CRLF; returns the line without CRLF. */
  async readLine(): Promise<string | null> {
    for (;;) {
      const idx = indexOfCRLF(this.buf);
      if (idx >= 0) {
        const line = this.buf.subarray(0, idx);
        this.buf = this.buf.subarray(idx + 2);
        return new TextDecoder().decode(line);
      }
      if (!(await this.pull())) return this.buf.byteLength ? "" : null;
    }
  }

  async readExact(n: number): Promise<Uint8Array> {
    while (this.buf.byteLength < n) {
      if (!(await this.pull())) break;
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(out.byteLength);
    return out;
  }

  /** Remaining buffered bytes plus everything until EOF. */
  async *readToEnd(): AsyncIterable<Uint8Array> {
    if (this.buf.byteLength) {
      yield this.buf;
      this.buf = new Uint8Array(0);
    }
    while (await this.pull()) {
      if (this.buf.byteLength) {
        yield this.buf;
        this.buf = new Uint8Array(0);
      }
    }
  }
}

function indexOfCRLF(buf: Uint8Array): number {
  for (let i = 0; i + 1 < buf.byteLength; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) return i;
  }
  return -1;
}

async function* dechunk(reader: ByteReader): AsyncIterable<Uint8Array> {
  for (;;) {
    const sizeLine = await reader.readLine();
    if (sizeLine === null) return;
    const size = parseInt(sizeLine.trim().split(";")[0] || "0", 16);
    if (Number.isNaN(size)) throw new Error("invalid chunk size");
    if (size === 0) {
      await reader.readLine(); // trailing CRLF after last chunk
      return;
    }
    const data = await reader.readExact(size);
    yield data;
    await reader.readExact(2); // CRLF after chunk data
  }
}

export async function http1Request(socket: RawSocket, req: Http1Request): Promise<Http1Response> {
  await socket.write(encodeRequest(req));
  const reader = new ByteReader(socket.read());

  const statusLine = await reader.readLine();
  if (!statusLine) throw new Error("empty HTTP response");
  const status = parseInt(statusLine.split(" ")[1] ?? "0", 10);

  const headers = new Headers();
  for (;;) {
    const line = await reader.readLine();
    if (line === null || line === "") break;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    headers.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }

  const chunked = (headers.get("transfer-encoding") ?? "").toLowerCase().includes("chunked");
  const body = chunked ? dechunk(reader) : reader.readToEnd();

  async function* stream(): AsyncIterable<Uint8Array> {
    try {
      yield* body;
    } finally {
      socket.close();
    }
  }
  return { status, headers, stream: stream() };
}
