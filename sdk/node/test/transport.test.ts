// Copyright (c) 2026 Tencent Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { getRuntime } from "../src/runtime.js";
import { createControlTransport, createDataTransport, FetchTransport } from "../src/transport/index.js";

describe("runtime detection", () => {
  it("detects node in the test environment", () => {
    const { runtime } = getRuntime();
    expect(runtime).toBe("node");
  });
});

describe("transport factory", () => {
  it("control transport is plain fetch (no host override)", () => {
    const t = createControlTransport(30_000);
    expect(t).toBeInstanceOf(FetchTransport);
    expect(t.supportsHostOverride).toBe(false);
  });

  it("data transport without proxy uses fetch", async () => {
    const t = await createDataTransport({ proxyPort: 80, requestTimeoutMs: 30_000 });
    expect(t).toBeInstanceOf(FetchTransport);
    expect(t.supportsHostOverride).toBe(false);
  });

  it("data transport with proxy on node uses undici with host override", async () => {
    const t = await createDataTransport({
      proxyNodeIp: "10.0.0.1",
      proxyPort: 80,
      requestTimeoutMs: 30_000,
    });
    expect(t.supportsHostOverride).toBe(true);
    expect(t.constructor.name).toBe("UndiciTransport");
    await t.close?.();
  });
});
