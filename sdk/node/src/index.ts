// Copyright (c) 2026 Tencent Inc.
// SPDX-License-Identifier: Apache-2.0

// Public API is built up phase by phase. P0 exposes runtime detection and the
// transport abstraction; P1 adds Config, errors, models, and the control-plane
// Sandbox surface. P2+ add data-plane methods (runCode/commands/files/pty).

export { getRuntime, runtime, runtimeVersion, getEnvVar } from "./runtime.js";
export type { Runtime } from "./runtime.js";

export {
  createControlTransport,
  createDataTransport,
  FetchTransport,
} from "./transport/index.js";
export type {
  Transport,
  TransportRequest,
  TransportResponse,
  TransportFactoryOptions,
} from "./transport/index.js";

export { Config } from "./config.js";
export type { ConfigOptions } from "./config.js";

export {
  CubeSandboxError,
  SandboxNotFoundError,
  TemplateNotFoundError,
  AuthenticationError,
  ApiError,
  FilesystemNotFoundError,
  UnsupportedRuntimeError,
  PartialWriteError,
} from "./errors.js";

export {
  Logs,
  ExecutionError,
  Result,
  Execution,
  SnapshotInfo,
  OutputMessage,
} from "./models.js";
export type { ResultData } from "./models.js";

export { Match, Inject, Action, Rule } from "./sandbox/network.js";
export type { Scheme, Method, AuditLevel, RuleDict } from "./sandbox/network.js";

export {
  Sandbox,
  JUPYTER_PORT,
  Commands,
  Pty,
  PtyHandle,
  Filesystem,
  WatchHandle,
} from "./sandbox/index.js";
export { SandboxApi } from "./sandbox/sandboxApi.js";
export type {
  SandboxData,
  NetworkPolicy,
  Lifecycle,
  CreateOptions,
  ConnectOptions,
  ListSnapshotsOptions,
  PauseOptions,
  SnapshotPage,
  RunCodeOptions,
  RunCodeCallbacks,
  CommandResult,
  CommandRunOptions,
  PtySize,
  PtyOutput,
  PtyCreateOptions,
  PtyConnectOptions,
  FileEntry,
  FsUserOptions,
  WatchEvent,
} from "./sandbox/index.js";

export { Template, TemplateBuild, TemplateInfo } from "./template.js";
export type {
  TemplateBuildOptions,
  TemplateConfigOptions,
  TemplateGetOptions,
} from "./template.js";

export { ENVD_PORT } from "./envd/connect.js";
