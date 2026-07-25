/**
 * Port of src/tools/web.py: webfetch, fetches the content of a URL as text.
 *
 * The only tool with egress beyond the LLM endpoint, so it comes DISABLED by
 * default (AGENT_ENABLE_WEBFETCH=1 or {"webfetch": true} in config.json).
 *
 * Per-redirect-hop SSRF guard (MIGRATION_SPEC section 4.6): resolves the host
 * with dns.promises.lookup({all: true}) and rejects if ANY IP is loopback,
 * link-local (includes 169.254.169.254), private, unspecified, reserved or
 * multicast; an unparseable IP is rejected (fail-closed). Manual redirects up
 * to MAX_REDIRECTS revalidating scheme and host.
 */

import dns from "node:dns/promises";
import net from "node:net";

import { config } from "../config.js";
import { ToolError } from "./errors.js";

export const MAX_REDIRECTS = 5;
// Response body cap (opencode's value): pages/files larger than this are
// rejected before becoming text, protecting memory and context.
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

const REDIRECT_STATUS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const FETCH_TIMEOUT_MS = 20_000;

// --- HTML text extractor (port of _TextExtractor without HTMLParser) ---------

const SKIP_TAGS: ReadonlySet<string> = new Set(["script", "style", "noscript"]);
// Raw-text elements: the content is skipped as a block until the closing tag.
const RAW_TEXT_TAGS: ReadonlySet<string> = new Set(["script", "style"]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  // nbsp becomes U+00A0, as in Python's HTMLParser
  nbsp: " ",
};

/** Decodes common character references (numeric and basic named). */
function decodeEntities(text: string): string {
  return text.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (full, ent: string) => {
    if (ent.startsWith("#")) {
      const hex = ent[1] === "x" || ent[1] === "X";
      const code = Number.parseInt(ent.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return full;
      try {
        return String.fromCodePoint(code);
      } catch {
        return full;
      }
    }
    return NAMED_ENTITIES[ent.toLowerCase()] ?? full;
  });
}

/** Joins the visible texts of the HTML, skipping script/style/noscript. */
function extractText(html: string): string {
  const lower = html.toLowerCase();
  const parts: string[] = [];
  let skipDepth = 0;
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf("<", i);
    const dataEnd = lt === -1 ? n : lt;
    if (dataEnd > i && skipDepth === 0) {
      const data = decodeEntities(html.slice(i, dataEnd)).trim();
      if (data) parts.push(data);
    }
    if (lt === -1) break;
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    const next = html[lt + 1];
    if (next === "!" || next === "?") {
      // doctype, CDATA or processing instruction
      const end = html.indexOf(">", lt);
      i = end === -1 ? n : end + 1;
      continue;
    }
    const end = html.indexOf(">", lt);
    if (end === -1) break; // tag never closed: discard the rest
    const rawTag = html.slice(lt + 1, end).trim();
    const closing = rawTag.startsWith("/");
    const selfClosing = rawTag.endsWith("/");
    const name =
      (closing ? rawTag.slice(1) : rawTag).split(/[\s/]+/, 1)[0]?.toLowerCase() ?? "";
    i = end + 1;
    if (!SKIP_TAGS.has(name)) continue;
    if (closing) {
      if (skipDepth > 0) skipDepth--;
    } else if (RAW_TEXT_TAGS.has(name) && !selfClosing) {
      const close = lower.indexOf(`</${name}`, i);
      if (close === -1) {
        i = n;
      } else {
        const gt = html.indexOf(">", close);
        i = gt === -1 ? n : gt + 1;
      }
    } else if (!selfClosing) {
      skipDepth++;
    }
  }
  return parts.join("\n");
}

// --- guard SSRF ----------------------------------------------------------------

function ipv6Groups(ip: string): number[] {
  // assumes a valid address (net.isIP === 6); expands "::" and embedded IPv4
  const toGroups = (chunk: string): number[] => {
    if (!chunk) return [];
    const out: number[] = [];
    for (const part of chunk.split(":")) {
      if (part.includes(".")) {
        const octets = part.split(".").map((o) => Number.parseInt(o, 10));
        out.push(((octets[0] as number) << 8) | (octets[1] as number));
        out.push(((octets[2] as number) << 8) | (octets[3] as number));
      } else {
        out.push(Number.parseInt(part, 16));
      }
    }
    return out;
  };
  const dc = ip.indexOf("::");
  if (dc === -1) return toGroups(ip);
  const head = toGroups(ip.slice(0, dc));
  const tail = toGroups(ip.slice(dc + 2));
  return [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
}

function isBlockedIpv4(a: number, b: number, c: number): boolean {
  return (
    a === 0 || // 0.0.0.0/8 (includes unspecified)
    a === 10 || // private
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64.0.0/10
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local (includes 169.254.169.254)
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
    (a === 192 && b === 0 && c === 2) || // TEST-NET-1
    (a === 192 && b === 168) || // private
    (a === 198 && (b === 18 || b === 19)) || // benchmarking 198.18.0.0/15
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast 224/4 + reserved 240/4 + broadcast
  );
}

/** True if `ip` is not a routable, safe public address (fail-closed). */
export function isBlockedIp(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) {
    const octets = ip.split(".").map((o) => Number.parseInt(o, 10));
    return isBlockedIpv4(octets[0] as number, octets[1] as number, octets[2] as number);
  }
  if (kind === 6) {
    const g = ipv6Groups(ip);
    if (g.length !== 8 || g.some((x) => !Number.isFinite(x))) return true;
    const [g0, g1] = [g[0] as number, g[1] as number];
    // IPv4-mapped (::ffff:a.b.c.d): the embedded IPv4 verdict applies
    if (g0 === 0 && g1 === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
      const hi = g[6] as number;
      const lo = g[7] as number;
      return isBlockedIpv4(hi >> 8, hi & 0xff, lo >> 8);
    }
    if (g.every((x) => x === 0)) return true; // :: unspecified
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1 loopback
    if ((g0 & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
    if ((g0 & 0xfe00) === 0xfc00) return true; // unique-local fc00::/7
    if ((g0 & 0xff00) === 0xff00) return true; // multicast ff00::/8
    if (g0 === 0x2001 && g1 === 0x0db8) return true; // documentation 2001:db8::/32
    // fail-closed: outside the 2000::/3 global unicast range, block
    return (g0 & 0xe000) !== 0x2000;
  }
  return true; // unparseable: reject
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Resolves the URL host and rejects if any IP is not public (SSRF guard). */
async function guardHost(url: string): Promise<void> {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    host = "";
  }
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (!host) throw new ToolError(`invalid URL, missing host: ${url}`);
  let infos: { address: string }[];
  try {
    infos = await dns.lookup(host, { all: true });
  } catch (e) {
    throw new ToolError(`failed to resolve host '${host}': ${errMessage(e)}`);
  }
  if (!infos.length) throw new ToolError(`failed to resolve host '${host}'`);
  for (const info of infos) {
    if (isBlockedIp(info.address)) {
      throw new ToolError(`access denied: '${host}' resolves to blocked address ${info.address}`);
    }
  }
}

// --- the tool -------------------------------------------------------------------

function decodeBody(buf: ArrayBuffer, contentType: string): string {
  const m = /charset=([^;]+)/i.exec(contentType);
  const charset = m ? (m[1] as string).trim().replace(/^["']|["']$/g, "") : "utf-8";
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

export async function webfetch(url: string, maxChars = 20_000): Promise<string> {
  if (!config.enableWebfetch) {
    throw new ToolError("webfetch is disabled (enable with AGENT_ENABLE_WEBFETCH=1)");
  }
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    throw new ToolError("only http(s) URLs are allowed");
  }
  let current = url;
  let resp: Response | null = null;
  let settled = false;
  for (let hop = 0; hop < MAX_REDIRECTS + 1; hop++) {
    await guardHost(current);
    try {
      resp = await fetch(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (e) {
      throw new ToolError(`failed to fetch ${current}: ${errMessage(e)}`);
    }
    if (REDIRECT_STATUS.has(resp.status)) {
      const location = resp.headers.get("location");
      if (!location) {
        settled = true;
        break;
      }
      current = new URL(location, current).toString();
      if (!current.startsWith("http://") && !current.startsWith("https://")) {
        throw new ToolError("only http(s) URLs are allowed");
      }
      continue;
    }
    settled = true;
    break;
  }
  if (!settled || resp === null) {
    throw new ToolError(`too many redirects (limit ${MAX_REDIRECTS})`);
  }
  const body = await resp.arrayBuffer();
  if (body.byteLength > MAX_RESPONSE_BYTES) {
    throw new ToolError(
      `response too large (${Math.floor(body.byteLength / (1024 * 1024))} MB; limit ` +
        `${Math.floor(MAX_RESPONSE_BYTES / (1024 * 1024))} MB)`,
    );
  }
  const contentType = resp.headers.get("content-type") ?? "";
  const raw = decodeBody(body, contentType);
  let text = contentType.includes("html") ? extractText(raw) : raw;
  if (text.length > maxChars) {
    text = text.slice(0, maxChars) + "\n... (content truncated)";
  }
  return `[${resp.status}] ${url}\n\n${text}`;
}
