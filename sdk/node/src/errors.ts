// Copyright (c) 2026 Tencent Inc.
// SPDX-License-Identifier: Apache-2.0

/** Base error for all CubeSandbox SDK failures. Mirrors Python `CubeSandboxError`. */
export class CubeSandboxError extends Error {
  readonly statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    // Restore prototype chain for instanceof across transpile targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The requested sandbox does not exist (HTTP 404 without "template" in message). */
export class SandboxNotFoundError extends CubeSandboxError {}

/** The requested template does not exist (HTTP 404 with "template" in message). */
export class TemplateNotFoundError extends CubeSandboxError {}

/** Authentication failed (HTTP 401/403). */
export class AuthenticationError extends CubeSandboxError {}

/** Generic control-plane API error. */
export class ApiError extends CubeSandboxError {}

/** A filesystem path was not found (HTTP 404 / not_found on the data plane). */
export class FilesystemNotFoundError extends CubeSandboxError {}

/**
 * Raised when the current runtime cannot satisfy a requested capability —
 * e.g. IP override on Vercel Edge / browser where `fetch` forbids the `Host`
 * header. Mirrors the design's degraded-runtime contract.
 */
export class UnsupportedRuntimeError extends CubeSandboxError {}

/**
 * A batch `writeFiles` partially succeeded. `written` holds the paths that were
 * durably written before the failure. Mirrors Python `PartialWriteError`.
 */
export class PartialWriteError extends CubeSandboxError {
  readonly written: string[];

  constructor(message: string, written: string[], statusCode?: number) {
    super(message, statusCode);
    this.written = written;
  }
}
