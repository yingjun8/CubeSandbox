// Copyright (c) 2026 Tencent Inc.
// SPDX-License-Identifier: Apache-2.0

// ndjson event stream from envd's Jupyter `/execute` endpoint. Each line is a
// JSON object with a `type` discriminator. Mirrors the Python SDK's
// `_stream._parse_line`.

import { Execution, ExecutionError, OutputMessage, Result, type ResultData } from "../models.js";

/** Callbacks invoked as `runCode` events stream in. */
export interface RunCodeCallbacks {
  onStdout?: (msg: OutputMessage) => void;
  onStderr?: (msg: OutputMessage) => void;
  onResult?: (result: Result) => void;
  onError?: (error: ExecutionError) => void;
}

/** Split a raw byte stream into UTF-8 lines (ndjson), stripping `\r`. */
export async function* iterateNdjsonLines(
  stream: AsyncIterable<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, idx);
      pending = pending.slice(idx + 1);
      yield line.endsWith("\r") ? line.slice(0, -1) : line;
    }
  }
  pending += decoder.decode();
  if (pending) yield pending.endsWith("\r") ? pending.slice(0, -1) : pending;
}

/** Fold one ndjson line into `execution`, firing any matching callback. */
export function parseLine(
  execution: Execution,
  line: string,
  callbacks: RunCodeCallbacks = {},
): void {
  if (!line) return;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return; // malformed JSON — skip, matching the Python SDK
  }

  const eventType = data.type as string | undefined;
  delete data.type;

  switch (eventType) {
    case "result": {
      const result = resultFromWire(data);
      execution.results.push(result);
      callbacks.onResult?.(result);
      break;
    }
    case "stdout": {
      const text = (data.text as string) ?? "";
      execution.logs.stdout.push(text);
      callbacks.onStdout?.(new OutputMessage(text, (data.timestamp as string) ?? ""));
      break;
    }
    case "stderr": {
      const text = (data.text as string) ?? "";
      execution.logs.stderr.push(text);
      callbacks.onStderr?.(new OutputMessage(text, (data.timestamp as string) ?? "", true));
      break;
    }
    case "error": {
      execution.error = new ExecutionError(
        (data.name as string) ?? "",
        (data.value as string) ?? "",
        data.traceback as string | string[] | undefined,
      );
      callbacks.onError?.(execution.error);
      break;
    }
    case "number_of_executions": {
      execution.executionCount = data.execution_count as number | undefined;
      break;
    }
    default:
      break; // unknown type — skip
  }
}

/**
 * Build a {@link Result} from a wire `result` event. The wire uses snake_case
 * (`is_main_result`) and E2B's `json_data` alias; map them onto the camelCase
 * model and drop any unrecognized keys, matching the Python SDK.
 */
function resultFromWire(data: Record<string, unknown>): Result {
  const init: ResultData = {
    text: data.text as string | undefined,
    html: data.html as string | undefined,
    markdown: data.markdown as string | undefined,
    svg: data.svg as string | undefined,
    png: data.png as string | undefined,
    jpeg: data.jpeg as string | undefined,
    pdf: data.pdf as string | undefined,
    latex: data.latex as string | undefined,
    json: (data.json ?? data.json_data) as Record<string, unknown> | undefined,
    javascript: data.javascript as string | undefined,
    data: data.data as Record<string, unknown> | undefined,
    chart: data.chart,
    isMainResult: Boolean(data.is_main_result ?? data.isMainResult),
    extra: data.extra as Record<string, unknown> | undefined,
  };
  return new Result(init);
}
