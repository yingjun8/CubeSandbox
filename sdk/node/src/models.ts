// Copyright (c) 2026 Tencent Inc.
// SPDX-License-Identifier: Apache-2.0

/** Captured stdout / stderr lines from a code execution. */
export class Logs {
  stdout: string[] = [];
  stderr: string[] = [];

  constructor(init?: { stdout?: string[]; stderr?: string[] }) {
    if (init?.stdout) this.stdout = init.stdout;
    if (init?.stderr) this.stderr = init.stderr;
  }
}

/** An error raised inside the executed code (kernel-level, not transport). */
export class ExecutionError {
  name: string;
  value: string;
  traceback: string;

  constructor(name: string, value: string, traceback?: string | string[]) {
    this.name = name;
    this.value = value;
    this.traceback = Array.isArray(traceback) ? traceback.join("\n") : traceback ?? "";
  }
}

/** Rich MIME formats that a result may carry. Mirrors Python `Result`. */
export interface ResultData {
  text?: string;
  html?: string;
  markdown?: string;
  svg?: string;
  png?: string;
  jpeg?: string;
  pdf?: string;
  latex?: string;
  json?: Record<string, unknown>;
  javascript?: string;
  data?: Record<string, unknown>;
  chart?: unknown;
  isMainResult?: boolean;
  extra?: Record<string, unknown>;
}

/** A single execution result carrying one or more rich MIME representations. */
export class Result implements ResultData {
  text?: string;
  html?: string;
  markdown?: string;
  svg?: string;
  png?: string;
  jpeg?: string;
  pdf?: string;
  latex?: string;
  json?: Record<string, unknown>;
  javascript?: string;
  data?: Record<string, unknown>;
  chart?: unknown;
  isMainResult = false;
  extra?: Record<string, unknown>;

  constructor(init: ResultData = {}) {
    Object.assign(this, init);
    this.isMainResult = init.isMainResult ?? false;
  }

  /** List of format keys present on this result. */
  formats(): string[] {
    const keys: (keyof ResultData)[] = [
      "text", "html", "markdown", "svg", "png", "jpeg",
      "pdf", "latex", "json", "javascript", "data", "chart",
    ];
    const out: string[] = keys.filter((k) => this[k] != null && this[k] !== "");
    if (this.extra) out.push(...Object.keys(this.extra));
    return out;
  }
}

/** The outcome of a `runCode` call: results, logs, and an optional error. */
export class Execution {
  results: Result[] = [];
  logs: Logs = new Logs();
  error?: ExecutionError;
  executionCount?: number;

  constructor(init?: Partial<Execution>) {
    if (init) Object.assign(this, init);
  }

  /** Text of the main result (the last expression's value), if any. */
  get text(): string | undefined {
    for (const r of this.results) {
      if (r.isMainResult) return r.text;
    }
    return undefined;
  }
}

/** Metadata returned by snapshot-related APIs. */
export class SnapshotInfo {
  snapshotId: string;
  names: string[];

  constructor(snapshotId: string, names: string[] = []) {
    this.snapshotId = snapshotId;
    this.names = names;
  }

  static fromDict(data: Record<string, unknown>): SnapshotInfo {
    return new SnapshotInfo(
      (data.snapshotID as string) ?? "",
      (data.names as string[]) ?? [],
    );
  }
}

/**
 * A single streamed output line from `runCode`. `text`/`isStderr` are E2B-
 * compatible aliases for `line`/`error`.
 */
export class OutputMessage {
  line: string;
  timestamp: number | string;
  error: boolean;

  constructor(line = "", timestamp: number | string = "", error = false) {
    this.line = line;
    this.timestamp = timestamp;
    this.error = error;
  }

  get text(): string {
    return this.line;
  }

  get isStderr(): boolean {
    return this.error;
  }

  toString(): string {
    return this.line;
  }
}
