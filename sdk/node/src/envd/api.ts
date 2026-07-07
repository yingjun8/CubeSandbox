// Copyright (c) 2026 Tencent Inc.
// SPDX-License-Identifier: Apache-2.0

// The slice of a live Sandbox that data-plane modules (commands, filesystem,
// runCode) depend on. Kept as a narrow interface so those modules never import
// the Sandbox class directly — mirroring how E2B threads a transport + config
// into its Commands/Filesystem instead of the whole Sandbox.

import type { Config } from "../config.js";
import type { Transport } from "../transport/types.js";

export interface DataPlane {
  /** Virtual hostname for a sandbox port, e.g. `49983-<id>.cube.app`. */
  getHost(port: number): string;
  readonly config: Config;
  /** In-sandbox envd access token, if the create response returned one. */
  readonly envdAccessToken?: string;
  /** Per-sandbox traffic token for `network.allowPublicTraffic=false`. */
  readonly trafficAccessToken?: string;
  /** Lazily-built, shared data-plane transport (CubeProxy-routed). */
  dataTransport(): Promise<Transport>;
}

/**
 * Headers common to every CubeProxy data-plane request. The traffic token is
 * always attached (CubeProxy rejects unauthenticated traffic with 403 when the
 * sandbox restricts public access); the envd `X-Access-Token` is opt-in because
 * the `/execute` endpoint does not expect it.
 */
export function dataHeaders(
  dp: DataPlane,
  opts: { accessToken?: boolean } = {},
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (opts.accessToken !== false && dp.envdAccessToken) {
    headers["X-Access-Token"] = dp.envdAccessToken;
  }
  if (dp.trafficAccessToken) {
    headers["e2b-traffic-access-token"] = dp.trafficAccessToken;
  }
  return headers;
}
