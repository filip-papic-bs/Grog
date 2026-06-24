import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const DEFAULT_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export interface CurlOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

/**
 * Fetch via the system `curl` binary instead of Node's fetch. Some Cloudflare
 * deployments (e.g. ws.duelbits.com) fingerprint the TLS/HTTP2 handshake and
 * 403 Node's undici client while letting curl through — no header tweak fixes
 * that, but curl's handshake passes. Returns the HTTP status + raw body.
 */
export async function curlText(
  url: string,
  opts: CurlOpts = {},
): Promise<{ status: number; body: string }> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const args = ["-s", "-m", String(Math.ceil(timeoutMs / 1000)), "-w", "\n%{http_code}"];
  if (opts.method) args.push("-X", opts.method);
  const headers = { "user-agent": DEFAULT_UA, ...(opts.headers ?? {}) };
  for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`);
  if (opts.body !== undefined) args.push("--data-binary", opts.body);
  args.push(url);

  const { stdout } = await exec("curl", args, { maxBuffer: 64 * 1024 * 1024 });
  const nl = stdout.lastIndexOf("\n");
  const status = Number(stdout.slice(nl + 1).trim());
  return { status, body: stdout.slice(0, nl) };
}

export async function curlJson<T>(url: string, opts: CurlOpts = {}): Promise<{ status: number; data: T }> {
  const { status, body } = await curlText(url, opts);
  return { status, data: JSON.parse(body) as T };
}
