// Copyright (c) 2026 Tencent Inc.
// SPDX-License-Identifier: Apache-2.0

// L7 egress policy types — host/path/SNI matching, audit, credential injection.
// These are pure data holders; matching happens server-side. `toWire()` emits
// the camelCase JSON that nests under `network.rules` in POST /sandboxes.

import { ApiError } from "../errors.js";

export type Scheme = "http" | "https";

export type Method =
  | "GET" | "HEAD" | "POST" | "PUT" | "PATCH"
  | "DELETE" | "OPTIONS" | "CONNECT" | "TRACE";

export type AuditLevel = "full" | "metadata" | "none";

/** Rule match conditions. All fields optional; empty Match matches any request. */
export class Match {
  constructor(
    public init: {
      sni?: string;
      host?: string;
      method?: Method[];
      path?: string;
      scheme?: Scheme;
    } = {},
  ) {}

  toWire(): Record<string, unknown> {
    const { sni, host, method, path, scheme } = this.init;
    const out: Record<string, unknown> = {};
    if (sni != null) out.sni = sni;
    if (host != null) out.host = host;
    if (method != null) out.method = [...method];
    if (path != null) out.path = path;
    if (scheme != null) out.scheme = scheme;
    return out;
  }
}

/** Credential injection. Only honored when `Action.allow=true` on HTTPS. */
export class Inject {
  constructor(
    public header: string,
    public secret: string,
    public format?: string,
  ) {}

  toWire(): Record<string, unknown> {
    const out: Record<string, unknown> = { header: this.header, secret: this.secret };
    if (this.format != null) out.format = this.format;
    return out;
  }
}

/** Rule action: allow (with optional injection) or reject (HTTP 403). */
export class Action {
  constructor(
    public allow: boolean,
    public opts: { inject?: Inject[]; audit?: AuditLevel } = {},
  ) {}

  toWire(): Record<string, unknown> {
    const out: Record<string, unknown> = { allow: this.allow };
    if (this.opts.audit != null) out.audit = this.opts.audit;
    if (this.opts.inject != null) out.inject = this.opts.inject.map((i) => i.toWire());
    return out;
  }
}

/** A single egress rule. `name` is a human-readable audit label. */
export class Rule {
  constructor(
    public name: string,
    public match: Match,
    public action: Action,
  ) {}

  toWire(): Record<string, unknown> {
    return { name: this.name, match: this.match.toWire(), action: this.action.toWire() };
  }
}

/** A rule expressed as a plain wire-shaped dict (camelCase keys). */
export type RuleDict = Record<string, unknown>;

export function serializeRule(rule: Rule | RuleDict): Record<string, unknown> {
  if (rule instanceof Rule) return rule.toWire();
  if (typeof rule !== "object" || rule === null) {
    throw new TypeError(`rule must be Rule or object, got ${typeof rule}`);
  }
  const out: Record<string, unknown> = {};
  if ("name" in rule) out.name = rule.name;
  if ("match" in rule && rule.match != null) out.match = { ...(rule.match as object) };
  if ("action" in rule && rule.action != null) {
    const a = rule.action as Record<string, unknown>;
    const action: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(a)) {
      action[k] = k === "inject" && v != null ? [...(v as unknown[])] : v;
    }
    out.action = action;
  }
  return out;
}

// ── E2B per-host request transforms compatibility ───────────────────────────
// E2B: network.rules is a host-keyed mapping of transforms:
//   { "api.example.com": [{ transform: { headers: { "X-Header": "v" } } }] }
// CubeEgress expresses the same as inject rules. This bridge converts an
// E2B-shaped mapping into rule dicts that `serializeRule` understands. A bare
// array (already CubeEgress-shaped) passes through untouched.

function isE2bPerHostRules(rules: unknown): rules is Record<string, unknown> {
  return typeof rules === "object" && rules !== null && !Array.isArray(rules);
}

function convertTransformToInject(transform: unknown): Inject[] {
  if (typeof transform !== "object" || transform === null) {
    throw new Error(`network.rules transform must be an object, got ${typeof transform}`);
  }
  const t = transform as Record<string, unknown>;
  const headers = t.headers;
  if (headers == null) {
    throw new Error("network.rules transform requires a 'headers' field");
  }
  if (typeof headers !== "object" || Array.isArray(headers)) {
    throw new Error("network.rules transform.headers must be an object");
  }
  const unknown = Object.keys(t).filter((k) => k !== "headers");
  if (unknown.length > 0) {
    throw new Error(
      `network.rules transform has unsupported keys: ${JSON.stringify(unknown.sort())}; ` +
        "only 'headers' is supported by the CubeEgress compatibility layer",
    );
  }
  const injects: Inject[] = [];
  for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
    if (!name) throw new Error("network.rules transform.headers keys must be non-empty strings");
    if (typeof value !== "string") {
      throw new Error(`network.rules transform.headers[${name}] must be a string`);
    }
    injects.push(new Inject(name, value));
  }
  return injects;
}

function convertE2bPerHostRules(rules: Record<string, unknown>): RuleDict[] {
  const converted: RuleDict[] = [];
  for (const [host, entries] of Object.entries(rules)) {
    if (!host) throw new Error("network.rules host keys must be non-empty strings");
    if (!Array.isArray(entries)) {
      throw new Error(`network.rules[${host}] must be an array of transform entries`);
    }
    entries.forEach((entry, index) => {
      if (typeof entry !== "object" || entry === null) {
        throw new Error(`network.rules[${host}][${index}] must be an object`);
      }
      const e = entry as Record<string, unknown>;
      const transform = e.transform;
      if (transform == null) {
        throw new Error(`network.rules[${host}][${index}] is missing the 'transform' field`);
      }
      const unknown = Object.keys(e).filter((k) => k !== "transform");
      if (unknown.length > 0) {
        throw new Error(
          `network.rules[${host}][${index}] has unsupported keys: ` +
            `${JSON.stringify(unknown.sort())}; only 'transform' is supported`,
        );
      }
      const injects = convertTransformToInject(transform);
      const suffix = entries.length === 1 ? "" : `-${index}`;
      converted.push({
        name: `e2b-transform-${host}${suffix}`,
        match: { host },
        action: { allow: true, inject: injects.map((i) => i.toWire()) },
      });
    });
  }
  return converted;
}

export function normalizeRulesArg(rules: unknown): (Rule | RuleDict)[] {
  if (!rules) return [];
  if (isE2bPerHostRules(rules)) return convertE2bPerHostRules(rules);
  if (Array.isArray(rules)) return rules as (Rule | RuleDict)[];
  throw new TypeError(`network.rules must be an array or object, got ${typeof rules}`);
}

// ── allow_out domain validation ─────────────────────────────────────────────

const DENY_ALL_IPV4_CIDR = "0.0.0.0/0";
const ALLOW_OUT_DOMAIN_REQUIRES_DENY_ALL =
  "When specifying allowed domains in allow_out, you must disable public " +
  "outbound traffic or include '0.0.0.0/0' in deny_out to block all other traffic.";

export function validateAllowOutDomainsRequireDenyAll(
  allowOut: string[] | undefined,
  denyOut: string[] | undefined,
  defaultDenyAll = false,
): void {
  if (!(allowOut ?? []).some(isDomainAllowOutTarget)) return;
  if (defaultDenyAll || (denyOut ?? []).some((t) => String(t).trim() === DENY_ALL_IPV4_CIDR)) {
    return;
  }
  throw new ApiError(ALLOW_OUT_DOMAIN_REQUIRES_DENY_ALL, 400);
}

function isDomainAllowOutTarget(target: unknown): boolean {
  if (typeof target !== "string") return false;
  const t = target.trim();
  if (!t || t.includes("/")) return false;
  if (isIpAddress(t)) return false;
  if (isDottedDecimalLike(t)) return false;
  let domain = t.replace(/\.+$/, "").toLowerCase();
  if (domain.startsWith("*.")) domain = domain.slice(2);
  else if (domain.includes("*")) return false;
  return isValidDnsDomainName(domain);
}

function isDottedDecimalLike(target: string): boolean {
  const parts = target.replace(/\.+$/, "").split(".");
  return parts.length === 4 && parts.every((p) => p.length > 0 && /^\d+$/.test(p));
}

function isIpAddress(t: string): boolean {
  // IPv4
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(t)) {
    return t.split(".").every((p) => Number(p) <= 255);
  }
  // IPv6 (loose): contains a colon and only hex/colon chars.
  return t.includes(":") && /^[0-9a-fA-F:]+$/.test(t);
}

function isValidDnsDomainName(domain: string): boolean {
  if (!domain || domain.length >= 255) return false;
  return domain.split(".").every(
    (label) =>
      !!label &&
      label.length <= 63 &&
      !label.startsWith("-") &&
      !label.endsWith("-") &&
      /^[a-zA-Z0-9-]+$/.test(label),
  );
}
