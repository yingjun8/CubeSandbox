# CubeSandbox Node.js / TypeScript SDK — 详细实现方案

> 对应 issue [#760](https://github.com/TencentCloud/CubeSandbox/issues/760)
> 目标:在 `sdk/node` 下提供官方 TS SDK,以 `@cubesandbox/sdk` 发布到 npm,**功能完整对齐 Python SDK(v0.3.0)**,并最大化跨运行时兼容。

---

## 1. 背景与目标

CubeSandbox 已有 Python(`sdk/python`)与 Go(`sdk/go`)两个官方 SDK。JS/TS 是 AI Agent 生态(Next.js、LangChain.js、Vercel AI SDK、NestJS、Serverless)的主力语言,缺一个第一方 TS SDK。

**目标**

- 与 Python SDK 功能对齐:创建/连接/列举/健康检查、跑代码(流式)、命令、文件系统、PTY、暂停/恢复、快照/克隆/回滚、Template 构建 API、网络策略(含 E2B 兼容形态)。
- API 命名对齐 E2B 习惯(`runCode`、`.text`、`onStdout`…),降低迁移成本。
- **可插拔传输层**,在 Node 上全功能(含 `CUBE_PROXY_NODE_IP` 远程 DNS 绕过),并能扩展到 Bun / Deno / Cloudflare Workers;Vercel Edge / 浏览器覆盖基础功能。
- async/await/Promise 优先,流式用 `AsyncIterable` + 回调双支持。

**非目标(首版)**

- 浏览器一等公民支持(CORS 限制,E2B 同样搁置)。
- Vercel Edge 上的 DNS 绕过(运行时物理不支持,给明确报错)。

---

## 2. 包信息与工程结构

- 包名:`@cubesandbox/sdk`
- 位置:`sdk/node`
- License:Apache-2.0
- 起始版本:`0.3.0`(与 Python 对齐;后续各自独立演进)
- 运行时要求:`node >= 18`(原生 fetch / undici 内置;远程传输用 undici Dispatcher)

```
sdk/node/
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── vitest.config.ts
├── README.md
├── DESIGN.md                     # 本文档
├── src/
│   ├── index.ts                  # 公共导出(对应 python __init__.py)
│   ├── config.ts                 # Config + 环境变量(对应 _config.py)
│   ├── errors.ts                 # 错误类型(对应 _exceptions.py)
│   ├── models.ts                 # Execution/Result/Logs/... (对应 _models.py)
│   ├── sandbox.ts                # Sandbox 主类(对应 sandbox.py)
│   ├── commands.ts               # sb.commands(对应 _commands.py)
│   ├── filesystem.ts             # sb.files + Watcher(对应 _filesystem.py)
│   ├── pty.ts                    # sb.pty(对应 _pty.py)
│   ├── template.ts               # Template 静态类(对应 _template.py)
│   ├── policy.ts                 # 网络策略 + E2B 兼容(对应 _policy.py)
│   ├── stream.ts                 # ndjson 解析(对应 _stream.py)
│   ├── runtime.ts                # 运行时探测(对齐 E2B getRuntime)
│   └── transport/
│       ├── types.ts              # Transport 接口定义
│       ├── index.ts              # 工厂:按运行时/配置选适配器
│       ├── fetch.ts              # 通用 fetch 适配器(无 IP 绕过)
│       ├── undici.ts             # Node/Bun:undici Dispatcher + IP 绕过
│       ├── deno.ts              # (Tier 2) Deno.connect 原始 TCP
│       └── cloudflare.ts         # (Tier 2) cf.resolveOverride / sockets
├── test/
│   ├── sandbox.test.ts
│   ├── commands.test.ts
│   ├── filesystem.test.ts
│   ├── pty.test.ts
│   ├── policy.test.ts
│   ├── template.test.ts
│   └── transport.test.ts
├── examples/
│   ├── create-and-run.ts
│   ├── lifecycle.ts
│   ├── commands-and-files.ts
│   ├── network-policy.ts
│   ├── pty.ts
│   └── list-and-health.ts
└── .github/workflows(复用仓库根 .github/workflows/publish-node-sdk.yml)
```

---

## 3. 工具链

| 用途 | 选型 | 说明 |
|---|---|---|
| 构建 | **tsup** | ESM + CJS 双产物 + `.d.ts`;`exports` 条件导出 |
| 测试 | **vitest** | 与 Python `pytest` 对齐的单测覆盖 |
| Mock | **undici MockAgent** | 拦截 undici/fetch 请求,零真实网络(对齐 Python 的 MockTransport) |
| Lint | tsc `--strict` + (可选)eslint | 严格类型 |

`package.json`(要点):

```jsonc
{
  "name": "@cubesandbox/sdk",
  "version": "0.3.0",
  "type": "module",
  "engines": { "node": ">=18" },
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.mjs",
      "require": "./dist/index.cjs"
    }
  },
  "main": "./dist/index.cjs",
  "module": "./dist/index.mjs",
  "types": "./dist/index.d.ts",
  "files": ["dist"],
  "sideEffects": false,
  "dependencies": {},
  "devDependencies": {
    "tsup": "^8", "vitest": "^2", "typescript": "^5", "undici": "^6"
  }
}
```

> `undici` 在 Node 18+ 已内置为全局 `fetch` 的底层;远程传输用 `undici` 的 `Agent`/`Dispatcher`。是否把 `undici` 声明为显式依赖还是仅用内置 `node:` 版本,见 §12 未决问题。

---

## 4. 运行时兼容策略(核心)

### 4.1 关键约束回顾

- **控制面**(CubeAPI,普通 URL):任何运行时的 `fetch` 直连即可。
- **数据面**(经 CubeProxy 到沙箱进程,虚拟 host `{port}-{sandboxID}.{domain}`):
  - 未设 `CUBE_PROXY_NODE_IP`:靠真实 DNS 解析 `*.cube.app`,`fetch` 直连即可。
  - 设了 `CUBE_PROXY_NODE_IP`(远程/自部署常见):必须"连 IP + 保留虚拟 Host 头"。这是唯一需要底层网络能力的动作。

### 4.2 各运行时可行性

| 运行时 | IP + 保留 Host | 实现手段 | 阶段 |
|---|:---:|---|:---:|
| Node | ✅ | `undici` 自定义 Dispatcher(`connect` 改目标 IP,Host 头保留) | Tier 1 |
| Bun | ✅ | 复用 undici 路径(Bun 兼容 undici / `node:net`) | Tier 2 |
| Deno | ✅ | `Deno.connect()` 原始 TCP,拼最小 HTTP/1.1 | Tier 2 |
| Cloudflare Workers | ✅ | `fetch(url,{cf:{resolveOverride:ip}})` 或 `cloudflare:sockets` `connect()` | Tier 2 |
| Vercel Edge | ❌ | 仅 `fetch`,`Host` 为禁止头被剥离,无原始 socket | Tier 3(报错) |
| 浏览器 | ❌ | CORS + 禁止 Host 头 | Tier 3(报错) |

Tier 3 环境在**未设 `CUBE_PROXY_NODE_IP`** 时,基础功能全部可用;设了则抛清晰错误。

### 4.3 Transport 抽象

```ts
// transport/types.ts
export interface TransportRequest {
  method: string;
  url: string;                 // 逻辑 URL(虚拟 host)
  headers: Record<string, string>;
  body?: Uint8Array | string;
  signal?: AbortSignal;
  timeoutMs?: number;
}
export interface TransportResponse {
  status: number;
  headers: Headers;
  text(): Promise<string>;
  bytes(): Promise<Uint8Array>;
  json<T = unknown>(): Promise<T>;
  stream(): AsyncIterable<Uint8Array>;   // 流式(ndjson / Connect frame)
}
export interface Transport {
  request(req: TransportRequest): Promise<TransportResponse>;
  /** 是否支持连 IP + 保留 Host(决定远程可用性) */
  readonly supportsHostOverride: boolean;
}
```

- 工厂 `transport/index.ts`:按 `runtime.ts` 探测 + `config.proxyNodeIp` 选适配器。
- **逃生舱**:`Sandbox.create({ transport })` 允许用户注入自定义实现。
- 未设 `proxyNodeIp` → 一律 `FetchTransport`(全平台通吃)。
- 设了 `proxyNodeIp`:
  - Node/Bun → `UndiciTransport`(Host override)。
  - Tier 2 环境 → 对应适配器。
  - Tier 3 环境 → `FetchTransport` 且 `supportsHostOverride=false`,在数据面调用点抛 `UnsupportedRuntimeError`。

### 4.4 Node undici 适配器要点

```ts
// 伪代码
import { Agent } from "undici";
const agent = new Agent({
  connect: (opts, cb) => {
    // 把目标主机名替换为 proxyNodeIp,端口用 proxyPort;
    // 但请求行/Host 头仍是虚拟 host —— undici 不强制禁止头。
    undiciConnect({ ...opts, hostname: proxyNodeIp, port: proxyPort }, cb);
  },
});
// request 时 dispatcher: agent,headers.host = 原虚拟 host
```

等价于 Python `IPOverrideTransport` 的行为(`curl --resolve`)。

---

## 5. 公共 API(全量对齐 Python)

### 5.1 Sandbox — 静态方法

```ts
class Sandbox {
  static create(opts?: CreateOptions): Promise<Sandbox>;
  static connect(sandboxId: string, opts?: ConnectOptions): Promise<Sandbox>;
  static list(config?: Config): Promise<SandboxInfo[]>;
  static listV2(config?: Config): Promise<SandboxInfo[]>;
  static health(config?: Config): Promise<{ status: string; sandboxes: number }>;
}
interface CreateOptions {
  template?: string;               // 默认取 config.templateId
  timeout?: number;                // 秒
  envVars?: Record<string, string>;
  metadata?: Record<string, string>;
  allowInternetAccess?: boolean;   // 仅 false 时进 payload
  network?: NetworkPolicy;         // allowOut/denyOut/allowPublicTraffic/rules
  lifecycle?: { onTimeout?: "kill" | "pause"; autoResume?: boolean };
  config?: Config;
  transport?: Transport;           // 逃生舱
}
```

### 5.2 Sandbox — 实例方法与属性

```ts
runCode(code: string, opts?: {
  language?: string;
  onStdout?: (m: OutputMessage) => void;
  onStderr?: (m: OutputMessage) => void;
  onResult?: (r: Result) => void;
  onError?: (e: ExecutionError) => void;
  envs?: Record<string, string>;
  timeout?: number;
}): Promise<Execution>;                      // POST http://{49999-host}/execute (ndjson)

getInfo(): Promise<SandboxInfo>;             // GET /sandboxes/:id
pause(opts?: { wait?: boolean; timeout?: number; interval?: number }): Promise<void>;
resume(timeout?: number): Promise<void>;     // deprecated,建议 connect
kill(): Promise<void>;                        // DELETE /sandboxes/:id
getHost(port: number): string;               // {port}-{id}.{domain}
get trafficAccessToken(): string | undefined;

// 快照 / 克隆 / 回滚
createSnapshot(name?: string): Promise<SnapshotInfo>;      // POST /sandboxes/:id/snapshots
static listSnapshots(opts?): Promise<{ snapshots: SnapshotInfo[]; nextToken?: string }>;
static deleteSnapshot(id: string): Promise<void>;          // DELETE /templates/:id
rollback(snapshotId: string): Promise<void>;               // POST /sandboxes/:id/rollback
clone(n: number, opts?: { concurrency?: number }): Promise<Sandbox[]>;

// 命名空间
readonly commands: Commands;
readonly files: Filesystem;
readonly pty: Pty;
```

### 5.3 commands

```ts
commands.run(cmd: string, opts?: {
  timeout?: number; cwd?: string;
  envs?: Record<string, string>; user?: string;
}): Promise<CommandResult>;   // { stdout, stderr, exitCode }
```
- envd `/process.Process/Start`,`cmd="/bin/bash"`,`args=["-l","-c",cmd]`。
- 直接手写 Connect-JSON 信封(不引 e2b protobuf 依赖),对齐 Python 的 fallback 路径。
- 退出码:`exitCode` → status 字符串 `"exit status N"` / `"signal N"`(→128+N)。

### 5.4 files

```ts
files.read(path: string, opts?: { user?: string }): Promise<string>;
files.write(path: string, data: string | Uint8Array, opts?: { user?: string }): Promise<void>;
files.writeFiles(files: [string, string | Uint8Array][], opts?): Promise<number>; // PartialWriteError
files.list(path: string): Promise<Entry[]>;
files.stat(path: string): Promise<Entry>;
files.exists(path: string): Promise<boolean>;
files.remove(path: string): Promise<void>;
files.rename(oldPath: string, newPath: string): Promise<Entry>;
files.makeDir(path: string): Promise<Entry>;
files.watchDir(path: string): Promise<Watcher>;  // AsyncIterable<WatchEvent> + close()
```
- read/write 走 envd `GET/POST /files`(octet-stream,≥400 时 multipart 回退)。
- 其余走 `/filesystem.Filesystem/{ListDir,Stat,Remove,Move,MakeDir,WatchDir}`(unary JSON / 流式 Connect frame)。

### 5.5 pty

```ts
pty.create(size: PtySize, opts?): Promise<PtyHandle>;   // /process.Process/Start (streaming)
pty.connect(pid: number, opts?): Promise<PtyHandle>;
pty.kill(pid: number): Promise<boolean>;
pty.sendStdin(pid: number, data: string | Uint8Array): Promise<void>;
pty.resize(pid: number, size: PtySize): Promise<void>;

class PtyHandle implements AsyncIterable<Uint8Array> {
  readonly pid: number;
  get exitCode(): number | undefined;
  wait(onData?: (chunk: Uint8Array) => void): Promise<number>;
  disconnect(): void;
  kill(): Promise<boolean>;
  sendStdin(data: string | Uint8Array): Promise<void>;
  resize(size: PtySize): Promise<void>;
}
```
- 输入默认 env:`TERM=xterm-256color`、`LANG/LC_ALL=C.UTF-8`;`args=["-i","-l"]`。
- PTY 数据 base64 编解码,流式 Connect frame。

### 5.6 Template(静态类)

```ts
Template.list(config?): Promise<TemplateInfo[]>;               // GET /templates
Template.get(id, opts?): Promise<TemplateInfo>;               // GET /templates/:id
Template.build(opts): Promise<TemplateBuild>;                 // POST /templates(image 必填)
Template.rebuild(id, extra?): Promise<TemplateBuild>;         // POST /templates/:id
Template.getBuildStatus(id, buildId): Promise<TemplateBuild>;
Template.getBuildLogs(id, buildId): Promise<Record<string, unknown>>;
Template.delete(id): Promise<void>;                           // DELETE /templates/:id
// Template.update → 抛 NotSupported(对齐 Python NotImplementedError)
```
- `build`:`dockerfile`/`startCmd` 传入即抛错;`image` 必填;`allow_out` 含域名需 deny-all 校验;`envs` → `["K=V"]`;`cpuCount→cpu`、`memoryMb→memory`。

---

## 6. 线路协议映射

### 6.1 ndjson(runCode)
- `POST http://{49999-host}/execute`,body `{ code, language, env_vars }`。
- 按行解析,事件类型:`result` / `stdout` / `stderr` / `error` / `number_of_executions`。
- `stream.ts` 提供 `parseLine(execution, line, callbacks)`,累积进 `Execution`。
- `.text`:`results` 里 `is_main_result` 的那条。

### 6.2 Connect 协议(commands / filesystem / pty)
- **unary**:`Content-Type: application/json`,无信封,响应为裸 JSON。
- **streaming**:`application/connect+json`,5 字节信封(1 flag + big-endian uint32 len)+ JSON 体。
- flags:`0x01` 压缩(不支持则报错),`0x02` end-stream(尾帧带 error 则抛)。
- `bytes` 字段(stdout/stderr/pty input)为 base64。
- 鉴权:`X-Access-Token`(来自 `envdAccessToken`);user 头 = Basic base64(`user:`),默认 `root`。

工具函数:`encodeConnectEnvelope(bytes)`、`iterConnectFrames(stream)`、`raiseConnectEndStream(frame)`。

---

## 7. 错误类型(errors.ts)

```ts
class CubeSandboxError extends Error { statusCode?: number; }
class SandboxNotFoundError extends CubeSandboxError {}
class TemplateNotFoundError extends CubeSandboxError {}
class AuthenticationError extends CubeSandboxError {}
class ApiError extends CubeSandboxError {}
class FilesystemNotFoundError extends CubeSandboxError {}
class PartialWriteError extends Error { written: number; }
class UnsupportedRuntimeError extends CubeSandboxError {}   // 新增:Edge/浏览器 + IP 绕过
```
- 控制面 `checkResponse`:401/403→Auth,404→Template/SandboxNotFound(按 msg 含 "template" 区分),其余→ApiError。

---

## 8. 网络策略(policy.ts)

- 类型:`Match` / `Inject` / `Action` / `Rule`,`toWire()` 输出 camelCase。
- `Scheme` / `Method` / `AuditLevel` 用 TS 联合字面量类型。
- E2B per-host transform:host-keyed dict → CubeEgress rule(名 `e2b-transform-<host>[-<index>]`)。
- 校验:`allow_out` 含域名必须 deny-all(`_validate_allow_out_domains_require_deny_all` 对应实现)。
- 兼容旧 `metadata["network-policy"]`。

---

## 9. Config(config.ts)与环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `CUBE_API_URL` | `http://127.0.0.1:3000` | 控制面(rstrip `/`) |
| `CUBE_TEMPLATE_ID` | — | 模板 ID |
| `CUBE_PROXY_NODE_IP` | — | 远程 IP 绕过 |
| `CUBE_PROXY_PORT_HTTP` | `80` | CubeProxy HTTP 端口 |
| `CUBE_SANDBOX_DOMAIN` | `cube.app` | 域名后缀 |

- `timeout=300`、`requestTimeout=30`。
- 环境变量读取通过 `runtime.ts` 兼容:Deno 用 `Deno.env.get`,无 `process` 时返回空。
- (可选,与 Go 对齐)读 `E2B_API_URL` / `E2B_API_KEY` fallback —— 见 §12 未决。

---

## 10. 测试策略(vitest + undici MockAgent)

对齐 Python `test_sandbox.py` 的零真实网络原则,用 `MockAgent` 拦截:

- `sandbox.test.ts`:create(payload 组装/allow_internet_access/network/lifecycle)、connect、list/listV2、health、getInfo、kill、pause(轮询)、resume。
- `commands.test.ts`:Connect 信封编解码、退出码解析(exitCode/status/signal)、user 头。
- `filesystem.test.ts`:read/write(multipart 回退)、list/stat/exists/remove/rename/makeDir、writeFiles(PartialWriteError)、Watcher frame 解析。
- `pty.test.ts`:create/connect start 事件、send_stdin/resize/kill、end 事件退出码。
- `policy.test.ts`:toWire、E2B per-host 转换、域名 deny-all 校验。
- `template.test.ts`:build payload、rebuild、status/logs、delete、update 抛错。
- `transport.test.ts`:运行时探测、未设/设 proxyNodeIp 的适配器选择、Host override 行为、Tier 3 抛 `UnsupportedRuntimeError`、自定义 transport 注入。

---

## 11. CI / 发布

- 新增 `.github/workflows/publish-node-sdk.yml`(复刻 `publish-python-sdk.yml`):
  - 触发:tag `node-sdk-v*`。
  - 校验:tag 版本 == `package.json` version。
  - 步骤:install → `vitest run` → `tsup` build → `npm publish --access public`(`NPM_TOKEN`)。
- 另加 PR CI:typecheck + test(所有 PR 跑)。

---

## 12. 分阶段落地

- **P0 脚手架**:package.json / tsconfig / tsup / vitest / runtime.ts / transport 抽象 + FetchTransport + UndiciTransport。
- **P1 控制面**:Config / errors / models / Sandbox 静态方法 + create/connect/kill/getInfo/pause/resume + 对应测试。
- **P2 数据面**:stream.ts(ndjson)+ runCode;Connect 工具 + commands;filesystem(含 Watcher)。
- **P3 高级**:pty、快照/克隆/回滚、Template 全套、policy(含 E2B 兼容)。
- **P4 兼容扩展**:Bun/Deno/Cloudflare 适配器 + examples + README + CI 发布。

每个阶段自带测试,绿灯后进下一阶段。

---

## 13. 已确认的决定

1. **包名/版本基线**:✅ `@cubesandbox/sdk` @ `0.3.0`,位置 `sdk/node`。
2. **undici 依赖形态**:✅ **显式依赖**(`dependencies` 里声明 `undici`),远程 Agent 从 `undici` 导入,不依赖 Node 内置版本的隐式行为。
3. **E2B 环境变量兼容**:✅ **兼容**。`CUBE_API_URL` 缺失时回退 `E2B_API_URL`;同时读 `E2B_API_KEY`/`CUBE_API_KEY`(对齐 Go SDK),便于 E2B 迁移零改配置。
4. **Tier 2 适配器(Bun/Deno/CF)**:✅ **首版就做**。Bun/Deno/Cloudflare Workers 适配器随首版发布;Vercel Edge/浏览器为 Tier 3(无 IP 绕过时基础功能可用,设 `proxyNodeIp` 则抛 `UnsupportedRuntimeError`)。

### 仍需实现时注意的技术点

- **ESM/CJS 双发**:tsup 双产物;`undici` 显式依赖在 CJS 下互操作需测试。
- **流式/Web Streams**:`AsyncIterable` 在 Node 18 稳定 → engines 卡 `>=18`。
- **Tier 2 原始 socket**:Deno(`Deno.connect`)/ CF(`cloudflare:sockets`)需手写最小 HTTP/1.1(chunked、Content-Length、keep-alive)+ 复用 Connect/ndjson 帧解析;Bun 优先复用 undici 路径。

---

## 依赖(package.json dependencies)

```jsonc
"dependencies": {
  "undici": "^6"
}
```
> 其余(tsup/vitest/typescript)为 devDependencies。

---

## 状态

设计已确认(§13 全部拍板)。按 §12 P0→P4 实现,Tier 2 适配器纳入首版(并入 P2/P4)。
