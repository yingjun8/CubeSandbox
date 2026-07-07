<p align="center">
  <strong>@cubesandbox/sdk</strong> — Node.js / TypeScript SDK for CubeSandbox
</p>

<p align="center">
  <a href="https://github.com/TencentCloud/CubeSandbox"><img src="https://img.shields.io/badge/CubeSandbox-GitHub-blue" alt="CubeSandbox" /></a>
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-green" alt="Apache 2.0" /></a>
  <img src="https://img.shields.io/badge/Node-%3E%3D18-blue" alt="Node >=18" />
  <img src="https://img.shields.io/badge/version-0.3.0-orange" alt="v0.3.0" />
</p>

---

`@cubesandbox/sdk` is the official Node.js / TypeScript SDK for
[CubeSandbox](https://github.com/TencentCloud/CubeSandbox). It provides a small,
strongly-typed interface to create sandboxes, execute code, run commands, drive a
PTY, manage the filesystem, and control the full sandbox lifecycle — including
pause/resume and snapshot/rollback with memory snapshot.

Ships ESM + CJS builds, full `.d.ts` types, and runtime adapters for Node, Bun,
Deno, and Cloudflare Workers.

## Installation

```bash
npm install @cubesandbox/sdk
# or: pnpm add @cubesandbox/sdk / yarn add @cubesandbox/sdk / bun add @cubesandbox/sdk
```

## Quick Start

Set the required environment variables:

```bash
export CUBE_API_URL=http://<your-cubeapi-host>:3000
export CUBE_TEMPLATE_ID=<your-template-id>

# Required for remote access (bypasses DNS for *.cube.app)
export CUBE_PROXY_NODE_IP=<your-cubeproxy-node-ip>
```

Run your first sandbox:

```ts
import { Sandbox } from "@cubesandbox/sdk";

const sb = await Sandbox.create();
try {
  const result = await sb.runCode("1 + 1");
  console.log(result.text); // "2"
} finally {
  await sb.kill();
}
```

## Features

### Execute code

```ts
import { Sandbox } from "@cubesandbox/sdk";

const sb = await Sandbox.create();
try {
  // Simple expression
  let result = await sb.runCode("x = 42\nx * 2");
  console.log(result.text); // "84"

  // Capture stdout
  result = await sb.runCode('print("hello")');
  console.log(result.logs.stdout); // ["hello\n"]

  // Stream output in real time
  await sb.runCode("for i in range(3): print(i)", {
    onStdout: (msg) => console.log("out:", msg.text),
  });
} finally {
  await sb.kill();
}
```

Variables persist across `runCode` calls for the lifetime of the sandbox — no
separate context object needed:

```ts
await sb.runCode("x = 100");
const result = await sb.runCode("x + 1");
console.log(result.text); // "101"
```

### Run shell commands

```ts
const result = await sb.commands.run("echo hello cube");
console.log(result.stdout); // "hello cube\n"
```

When `user` is omitted, the SDK sends requests as `root` for compatibility with
envd versions that reject process/file requests without an explicit user.

### PTY (pseudo-terminal)

```ts
const handle = await sb.pty.create({ rows: 24, cols: 80 });
await sb.pty.sendStdin(handle.pid, "echo hi\n");

// Stream output; `wait` resolves with the exit code.
const code = await handle.wait((chunk) => {
  process.stdout.write(new TextDecoder().decode(chunk));
});
console.log("exit:", code);

// Resize / kill
await sb.pty.resize(handle.pid, { rows: 40, cols: 120 });
await sb.pty.kill(handle.pid);
```

### Filesystem

```ts
// Read & write
await sb.files.write("/tmp/hello.txt", "Hello, world!");
console.log(await sb.files.read("/tmp/hello.txt")); // "Hello, world!"

// Directory operations
await sb.files.makeDir("/tmp/mydir");
const entries = await sb.files.list("/tmp");
const info = await sb.files.stat("/tmp/hello.txt");
console.log(await sb.files.exists("/tmp/hello.txt")); // true
await sb.files.rename("/tmp/hello.txt", "/tmp/renamed.txt");
await sb.files.remove("/tmp/renamed.txt");

// Watch for changes
const watcher = await sb.files.watchDir("/tmp");
for await (const event of watcher) {
  console.log(event.name, event.type); // e.g. "a.txt" "EVENT_TYPE_CREATE"
}
```

### Pause & resume

```ts
const sb = await Sandbox.create();

// Pause — preserves memory snapshot, polls until state=paused
await sb.pause();                                  // wait=true, timeout=30s by default
await sb.pause({ wait: false });                   // fire-and-forget
await sb.pause({ timeoutMs: 60_000, intervalMs: 500 });

// Resume by connecting — auto-resumes a paused sandbox, returns a fresh instance
const sb2 = await Sandbox.connect(sb.sandboxId);
```

### Snapshots, rollback & clone

```ts
// Snapshot the current filesystem + memory (outlives the sandbox)
const snap = await sb.createSnapshot("v1");

// List snapshots (paginated via nextToken)
const page = await sb.listSnapshots();

// Roll the running sandbox back to a snapshot (restarts from the image)
await sb.rollback(snap.snapshotId);

// Clone: snapshot -> create N sandboxes -> delete the ephemeral snapshot
const clones = await sb.clone(3, { concurrency: 3 });
```

### Templates

```ts
import { Template } from "@cubesandbox/sdk";

// Build a template from a container image
const build = await Template.build({
  image: "python:3.11-slim",
  cpuCount: 2,
  memoryMb: 2048,
});
console.log(build.jobId, build.status);

// Poll build status / list / get
await Template.getBuildStatus(build.templateId, build.buildId);
const templates = await Template.list();
const info = await Template.get(build.templateId);

// Rebuild or delete
await Template.rebuild(build.templateId);
await Template.delete(build.templateId);
```

### Network policy

Two layers can be combined inside `network`:

- **L3/L4** — `allowOut` / `denyOut` lists of CIDRs or hostnames.
- **L7** — `rules` for host / path / SNI matching, audit, and credential
  injection. Use the typed `Rule` / `Match` / `Action` / `Inject` classes.

```ts
import { Sandbox, Rule, Match, Action, Inject } from "@cubesandbox/sdk";

const rules = [
  new Rule(
    "deepseek_api",
    new Match({
      scheme: "https",
      host: "api.deepseek.com",
      method: ["POST"],
      path: "/v1/chat",
      sni: "api.deepseek.com",
    }),
    new Action(true, {
      audit: "metadata",
      inject: [new Inject("Authorization", "sk_xxxx", "Bearer ${SECRET}")],
    }),
  ),
];

const sb = await Sandbox.create({
  network: { allowOut: ["172.67.0.0/16"], rules },
});
```

Rules are evaluated **first-match-wins** in list order. Credential injection only
runs on HTTPS requests where SNI and Host match (server-enforced).

`network.rules` also accepts E2B's host-keyed
[per-host request transforms](https://e2b.dev/docs/network/internet-access#per-host-request-transforms)
shape for drop-in compatibility:

```ts
const sb = await Sandbox.create({
  network: {
    allowOut: ["api.example.com"],
    denyOut: ["0.0.0.0/0"],
    rules: { "api.example.com": [{ transform: { headers: { "X-Header": "Content" } } }] },
  },
});
```

Pass either a list of typed `Rule` **or** a host-keyed object — mixing the two on
a single call is not supported.

### List & health check

```ts
console.log(await Sandbox.health());  // { status: "ok", sandboxes: 4 }
console.log(await Sandbox.list());    // running sandboxes (v1)
console.log(await Sandbox.listV2());  // v2 API (server-side filtering)
```

## Configuration

| Environment Variable | Required | Default | Description |
|---|:---:|---|---|
| `CUBE_API_URL` | ✅ | `http://127.0.0.1:3000` | CubeAPI management plane address |
| `CUBE_TEMPLATE_ID` | ✅ | — | Template ID for sandbox creation |
| `CUBE_PROXY_NODE_IP` | remote | — | CubeProxy node IP, bypasses DNS for `*.cube.app` |
| `CUBE_PROXY_PORT_HTTP` | | `80` | CubeProxy HTTP port |
| `CUBE_SANDBOX_DOMAIN` | | `cube.app` | Sandbox domain suffix |
| `CUBE_API_KEY` | | — | API key (falls back to `E2B_API_KEY`) |

**E2B compatibility:** when `CUBE_API_URL` is unset it falls back to `E2B_API_URL`,
and the API key is read from either `CUBE_API_KEY` or `E2B_API_KEY` — existing
E2B-configured environments work without re-keying.

You can also pass a `Config` object directly:

```ts
import { Config, Sandbox } from "@cubesandbox/sdk";

const cfg = new Config({
  apiUrl: "http://10.0.0.1:3000",
  templateId: "tpl-xxxxxxxxxxxxxxxxxxxxxxxx",
  proxyNodeIp: "10.0.0.1",
});
const sb = await Sandbox.create({ config: cfg });
```

## Runtime support

| Runtime | IP override (`CUBE_PROXY_NODE_IP`) | Adapter |
|---|:---:|---|
| Node.js ≥ 18 | ✅ | `undici` |
| Bun | ✅ | `undici` |
| Deno | ✅ | `Deno.connect` |
| Cloudflare Workers | ✅ | `cloudflare:sockets` |
| Vercel Edge / browser | ⚠️ basic only | `fetch` |

Runtimes without raw-socket / Host-override capability fall back to plain `fetch`;
data-plane calls that require the override throw `UnsupportedRuntimeError`.

## DNS Bypass (Remote Access)

When running outside the CubeSandbox node, `*.cube.app` cannot be resolved by the
OS DNS. Set `CUBE_PROXY_NODE_IP` to route all data-plane connections directly to
that IP with the virtual `Host` header preserved for CubeProxy routing.

```
Without CUBE_PROXY_NODE_IP:
  SDK → OS DNS (*.cube.app) → CubeProxy

With CUBE_PROXY_NODE_IP:
  SDK → TCP direct to CUBE_PROXY_NODE_IP:80
        Host: 49999-{sandboxID}.cube.app (preserved for routing)
```

## License

Apache-2.0 © 2026 Tencent Inc.
