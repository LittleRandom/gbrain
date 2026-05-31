/**
 * `gbrain connect` — one-command coding-agent onboarding from a bearer token.
 *
 * Turns an MCP URL + bearer token into a paste-ready block (or wires it up
 * directly with --install) that connects Claude Code straight to a remote
 * `gbrain serve --http` and teaches the agent to self-orient via
 * `list_skills` / `get_brain_identity`. Direct HTTP MCP — no local install or
 * thin-client config needed for the connection.
 *
 *   gbrain connect <mcp-url> [--token <bearer>] [--name gbrain]
 *                  [--agent claude-code|generic] [--install] [--yes]
 *                  [--json] [--show-token] [--force] [--timeout-ms N]
 *
 * Token resolution: --token > $GBRAIN_REMOTE_TOKEN > (print) placeholder /
 * (install) error. Default token form is the LITERAL token inline in the
 * command (matches docs/mcp/CLAUDE_CODE.md and is verified to work). Env-var
 * indirection is deferred until Claude Code's runtime header `${VAR}` expansion
 * is verified (see plan T6 / TODOS).
 */

import { execFileSync } from 'child_process';
import type { ConnectProbeResult } from '../core/connect-probe.ts';
import { probeBrainIdentity, DEFAULT_PROBE_TIMEOUT_MS } from '../core/connect-probe.ts';
import { promptLine } from '../core/cli-util.ts';

export const ENV_VAR = 'GBRAIN_REMOTE_TOKEN';
export const PLACEHOLDER_TOKEN = '<paste-your-token>';
export const REDACTED = '***';
export const DEFAULT_NAME = 'gbrain';
const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
// Single source of truth shared with the probe (was a duplicated 15_000 literal).
const DEFAULT_TIMEOUT_MS = DEFAULT_PROBE_TIMEOUT_MS;

export const LEARN_INSTRUCTION =
  'Once connected, call the `get_brain_identity` tool (whose brain this is), then ' +
  '`list_skills` (everything it can do; if it errors, the host has not enabled skill ' +
  'publishing — these core tools still work: search, query, get_page, put_page, ' +
  'capture, think, find_experts). Always search the brain before answering or writing.';

const HELP = `gbrain connect — wire a coding agent to a remote gbrain over MCP

Usage:
  gbrain connect <mcp-url> [--token <bearer>] [flags]

Prints a copy-paste block for Claude Code (default), or wires it up directly
with --install. The MCP URL is your remote 'gbrain serve --http' endpoint;
a bare host is rejected — pass an explicit https:// URL.

Flags:
  --token <bearer>     Bearer token (else $${ENV_VAR}; from 'gbrain auth create')
  --name <id>          MCP server name in the agent (default: ${DEFAULT_NAME})
  --agent <kind>       claude-code (default) | generic
  --install            Run 'claude mcp add' for you, then smoke-test the token
  --yes                Skip the install confirmation prompt
  --force              On --install, replace an existing server of the same name
  --json               Emit machine-readable JSON (token redacted)
  --show-token         With --json, include the literal token (avoid in logs)
  --timeout-ms <n>     Smoke-test timeout for --install (default: ${DEFAULT_TIMEOUT_MS})

Examples:
  gbrain connect https://brain.example.com/mcp --token gbrain_xxx
  gbrain connect https://brain.example.com:3131 --install --yes
  GBRAIN_REMOTE_TOKEN=gbrain_xxx gbrain connect https://brain.example.com/mcp --json
`;

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in test/connect.test.ts)
// ---------------------------------------------------------------------------

export type UrlResult =
  | { ok: true; url: string; warning?: string }
  | { ok: false; error: string };

/**
 * Block link-local / cloud-metadata addresses — the one class of host that is
 * never a legitimate brain endpoint but IS a token-exfil target (e.g. the AWS/
 * GCP metadata service at 169.254.169.254). Deliberately does NOT block
 * localhost or RFC1918/LAN ranges: self-hosted brains on a private network are
 * a documented, supported topology (`gbrain serve --http --bind`).
 */
export function isLinkLocalOrMetadata(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(h)) return true; // IPv4 link-local incl. cloud metadata
  if (h.startsWith('fe80:')) return true;                  // IPv6 link-local
  if (h === 'fd00:ec2::254') return true;                  // AWS IMDSv2 over IPv6
  // IPv4-mapped IPv6 (e.g. ::ffff:169.254.169.254 dotted, or ::ffff:a9fe:xxxx
  // hex where a9fe == 169.254) must not slip past the dotted-IPv4 check.
  const mapped = h.match(/^::ffff:(.+)$/);
  if (mapped) {
    if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(mapped[1])) return true;
    if (mapped[1].startsWith('a9fe:')) return true;
  }
  return false;
}

/**
 * Normalize an MCP URL to a canonical `<scheme>//<host><path>` ending in /mcp.
 * Explicit spec (not best-effort) — see plan D-codex findings.
 */
export function normalizeMcpUrl(input: string): UrlResult {
  const raw = (input ?? '').trim();
  if (!raw) {
    return { ok: false, error: 'Missing MCP URL. Usage: gbrain connect <https://host/mcp> --token <bearer>' };
  }
  // Require an explicit scheme. A bare `host:3131` parses as scheme `host:`
  // under WHATWG URL, so reject anything without `://`.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    const guess = raw.replace(/^\/+/, '');
    return { ok: false, error: `Add an explicit scheme, e.g. https://${guess} (a bare host:port is ambiguous).` };
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: `Invalid URL: ${raw}` };
  }
  const scheme = u.protocol.toLowerCase();
  if (scheme !== 'http:' && scheme !== 'https:') {
    return { ok: false, error: `Only http(s) URLs are supported (got ${u.protocol}).` };
  }
  if (u.username || u.password) {
    return { ok: false, error: 'Remove credentials from the URL (user:pass@host is not supported); pass the token via --token.' };
  }
  if (u.search) {
    return { ok: false, error: 'Remove the query string from the MCP URL.' };
  }
  if (isLinkLocalOrMetadata(u.hostname)) {
    return { ok: false, error: `Refusing to target a link-local / cloud-metadata address (${u.hostname}). Point the MCP URL at the brain host's real address.` };
  }
  const host = u.host; // host:port; hostname already lowercased by URL
  const path = u.pathname;
  const trimmed = path.replace(/\/+$/, '');
  const lower = trimmed.toLowerCase();
  let finalPath: string;
  if (path === '' || path === '/') {
    finalPath = '/mcp';
  } else if (lower === '/mcp') {
    finalPath = '/mcp';
  } else {
    return {
      ok: false,
      error: `Unexpected path '${path}'. Pass the full /mcp URL, e.g. ${scheme}//${host}${trimmed}/mcp`,
    };
  }
  const url = `${scheme}//${host}${finalPath}`;
  const hn = u.hostname.toLowerCase();
  const isLocal = hn === 'localhost' || hn === '127.0.0.1' || hn === '::1' || hn === '[::1]';
  if (scheme === 'http:' && !isLocal) {
    return { ok: true, url, warning: 'Warning: http:// sends your bearer token unencrypted. Use https:// unless this is localhost.' };
  }
  return { ok: true, url };
}

export type TokenValidation = { ok: true } | { ok: false; error: string };

/** Reject empty/whitespace/control-char tokens (a newline is a header-injection vector). */
export function validateToken(token: string): TokenValidation {
  if (!token || !token.trim()) return { ok: false, error: 'Token is empty.' };
  if (/\s/.test(token)) return { ok: false, error: 'Token contains whitespace (space/tab/newline) — refusing (header-injection risk).' };
  if (/[\x00-\x1f\x7f]/.test(token)) return { ok: false, error: 'Token contains control characters — refusing (header-injection risk).' };
  return { ok: true };
}

export type TokenResolution =
  | { kind: 'literal'; token: string }
  | { kind: 'placeholder' }
  | { kind: 'error'; error: string };

export function resolveToken(opts: { tokenFlag?: string | null; env?: string | null; mode: 'print' | 'install' }): TokenResolution {
  const t = opts.tokenFlag ?? opts.env ?? null;
  if (t != null && t !== '') {
    const v = validateToken(t);
    if (!v.ok) return { kind: 'error', error: v.error };
    return { kind: 'literal', token: t };
  }
  if (opts.mode === 'print') return { kind: 'placeholder' };
  return {
    kind: 'error',
    error: `No token. Pass --token <bearer> or set ${ENV_VAR}. Create one on the host with: gbrain auth create "<name>"`,
  };
}

export function isValidName(name: string): boolean {
  return NAME_RE.test(name);
}

export function buildClaudeMcpAddArgv(p: { name: string; url: string; headerToken: string }): string[] {
  return ['mcp', 'add', p.name, '-t', 'http', p.url, '-H', `Authorization: Bearer ${p.headerToken}`];
}

/**
 * Render an argv to a copy-pasteable `claude ...` shell string. Args that
 * aren't already shell-safe are POSIX single-quoted (so `$()`, backticks, etc.
 * in a bearer token are inert literals when the block is pasted into a shell —
 * double-quoting would still allow command substitution).
 */
function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_.:/@-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}
export function claudeMcpAddCmdString(argv: string[]): string {
  return `claude ${argv.map(shellQuote).join(' ')}`;
}

export function redactToken(s: string, token: string | null): string {
  // Exact-substring scrub of the known token, plus a defense-in-depth pass over
  // any `Bearer <value>` shape the SDK/CLI might echo in a transformed form the
  // exact match would miss. Both run on the --install error paths only.
  let out = token ? s.split(token).join(REDACTED) : s;
  out = out.replace(/Bearer\s+\S+/gi, `Bearer ${REDACTED}`);
  return out;
}

export function buildConnectBlock(p: { agent: 'claude-code' | 'generic'; name: string; url: string; token: string | null }): string {
  const headerToken = p.token ?? PLACEHOLDER_TOKEN;
  if (p.agent === 'generic') {
    return [
      '# Add an HTTP MCP server pointed at your gbrain:',
      `#   URL:    ${p.url}`,
      `#   Header: Authorization: Bearer ${headerToken}`,
      '',
      LEARN_INSTRUCTION,
    ].join('\n');
  }
  const cmd = claudeMcpAddCmdString(buildClaudeMcpAddArgv({ name: p.name, url: p.url, headerToken }));
  const lines = [
    '# Paste into Claude Code:',
    '',
    'Connect my knowledge brain, then learn what it can do:',
    '',
    `  ${cmd}`,
    '',
  ];
  if (!p.token) {
    lines.push(`Replace ${PLACEHOLDER_TOKEN} with a token from \`gbrain auth create "claude-code"\` on the host.`, '');
  }
  lines.push(
    LEARN_INSTRUCTION,
    '',
    'Note: that bearer token is a long-lived, full-access secret — keep it private and prefer a scoped/short-lived token if your host supports one.',
  );
  return lines.join('\n');
}

export function buildJson(p: { url: string; name: string; agent: string; token: string | null; showToken: boolean }): Record<string, unknown> {
  const headerToken = p.token ? (p.showToken ? p.token : REDACTED) : PLACEHOLDER_TOKEN;
  const argv = buildClaudeMcpAddArgv({ name: p.name, url: p.url, headerToken });
  return {
    schema_version: 1,
    mcp_url: p.url,
    name: p.name,
    agent: p.agent,
    env_var: ENV_VAR,
    token_present: p.token != null,
    token_redacted: p.token != null && !p.showToken,
    claude_mcp_add_argv: argv,
    claude_mcp_add_cmd: claudeMcpAddCmdString(argv),
    learn_instruction: LEARN_INSTRUCTION,
  };
}

// ---------------------------------------------------------------------------
// --install dependencies (injectable for tests; E2E exercises the real ones)
// ---------------------------------------------------------------------------

export interface ConnectDeps {
  isTTY(): boolean;
  promptYesNo(question: string): Promise<boolean>;
  hasClaude(): boolean;
  runClaude(argv: string[]): { code: number; stdout: string; stderr: string };
  probe(url: string, token: string, timeoutMs: number): Promise<ConnectProbeResult>;
}

async function defaultPromptYesNo(question: string): Promise<boolean> {
  // Reuse the shared prompt helper so stdin pause/resume lifecycle matches the
  // rest of the interactive CLI flows (init, apply-migrations, ...).
  const answer = (await promptLine(`${question} (y/N): `)).toLowerCase();
  return answer === 'y' || answer === 'yes';
}

function defaultRunClaude(argv: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('claude', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout: stdout ?? '', stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
    return {
      code: typeof err.status === 'number' ? err.status : 1,
      stdout: err.stdout ? String(err.stdout) : '',
      stderr: err.stderr ? String(err.stderr) : (err.message ?? ''),
    };
  }
}

const defaultDeps: ConnectDeps = {
  isTTY: () => !!process.stdin.isTTY,
  promptYesNo: defaultPromptYesNo,
  hasClaude: () => {
    try {
      execFileSync('claude', ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  },
  runClaude: defaultRunClaude,
  probe: (url, token, timeoutMs) => probeBrainIdentity(url, token, { timeoutMs }),
};

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

interface ParsedFlags {
  url?: string;
  token?: string;
  name: string;
  agent: 'claude-code' | 'generic';
  install: boolean;
  yes: boolean;
  force: boolean;
  json: boolean;
  showToken: boolean;
  timeoutMs: number;
  help: boolean;
  agentError?: string;
  argError?: string;
}

function parseArgs(args: string[]): ParsedFlags {
  const out: ParsedFlags = {
    name: DEFAULT_NAME,
    agent: 'claude-code',
    install: false,
    yes: false,
    force: false,
    json: false,
    showToken: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    help: false,
  };
  // Read the value for a value-taking flag, refusing a missing value or one
  // that is itself a flag (e.g. `--token --install` would otherwise silently
  // consume `--install` as the token and leave install off). Shares `i` with
  // the loop below, so it is declared in the function body, not the for-header.
  let i = 0;
  const takeValue = (flag: string): string | undefined => {
    const v = args[i + 1];
    if (v === undefined || v.startsWith('--')) {
      out.argError = `${flag} requires a value.`;
      return undefined;
    }
    i++;
    return v;
  };
  for (; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case '--help': case '-h': out.help = true; break;
      case '--install': out.install = true; break;
      case '--yes': case '-y': out.yes = true; break;
      case '--force': out.force = true; break;
      case '--json': out.json = true; break;
      case '--show-token': out.showToken = true; break;
      case '--token': { const v = takeValue('--token'); if (v !== undefined) out.token = v; break; }
      case '--name': { const v = takeValue('--name'); if (v !== undefined) out.name = v; break; }
      case '--agent': {
        const v = takeValue('--agent');
        if (v === undefined) break;
        if (v === 'claude-code' || v === 'generic') out.agent = v;
        else out.agentError = `Unknown --agent '${v}'. Use claude-code or generic.`;
        break;
      }
      case '--timeout-ms': {
        const raw = takeValue('--timeout-ms');
        if (raw === undefined) break;
        const n = parseInt(raw, 10);
        if (Number.isFinite(n) && n > 0) out.timeoutMs = n;
        break;
      }
      default:
        if (!a.startsWith('-') && out.url === undefined) out.url = a;
        break;
    }
  }
  return out;
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

export async function runConnect(args: string[], deps: ConnectDeps = defaultDeps): Promise<void> {
  const f = parseArgs(args);
  if (f.help) {
    console.log(HELP);
    return;
  }
  if (f.argError) fail(f.argError);
  if (f.agentError) fail(f.agentError);
  if (!isValidName(f.name)) {
    fail(`Invalid --name '${f.name}'. Use a lowercase identifier matching ${NAME_RE}.`);
  }

  const norm = normalizeMcpUrl(f.url ?? '');
  if (!norm.ok) fail(norm.error);
  if (norm.warning) console.error(norm.warning);
  const url = norm.url;

  const mode = f.install ? 'install' : 'print';
  const tok = resolveToken({ tokenFlag: f.token ?? null, env: process.env[ENV_VAR] ?? null, mode });
  if (tok.kind === 'error') fail(tok.error);
  const token: string | null = tok.kind === 'literal' ? tok.token : null;

  if (!f.install) {
    if (f.json) {
      console.log(JSON.stringify(buildJson({ url, name: f.name, agent: f.agent, token, showToken: f.showToken }), null, 2));
    } else {
      console.log(buildConnectBlock({ agent: f.agent, name: f.name, url, token }));
    }
    return;
  }

  // --install path. token is guaranteed literal here (install mode resolveToken).
  const realToken = token as string;
  if (f.agent !== 'claude-code') {
    fail('--install only supports --agent claude-code. For other agents, drop --install and use the printed block.');
  }
  if (!deps.hasClaude()) {
    fail("Claude Code CLI ('claude') not found on PATH. Install Claude Code, or drop --install to print the command to run manually.");
  }

  const exists = deps.runClaude(['mcp', 'get', f.name]).code === 0;
  if (exists && !f.force) {
    fail(`An MCP server named '${f.name}' already exists in Claude Code. Run 'claude mcp remove ${f.name}' first, pass --name <other>, or --force to replace it.`);
  }

  if (!f.yes) {
    if (!deps.isTTY()) {
      // Non-interactive --install registers a credential-bearing MCP server and
      // fires the token at a remote host — require an explicit --yes rather than
      // silently proceeding when there's no TTY to confirm at.
      fail('--install in a non-interactive shell requires --yes (refusing to register a credential-bearing MCP server without confirmation).');
    }
    const ok = await deps.promptYesNo(`Add MCP server '${f.name}' -> ${url} to Claude Code?`);
    if (!ok) fail('Aborted.');
  }

  let removedExisting = false;
  if (exists && f.force) {
    const rm = deps.runClaude(['mcp', 'remove', f.name]);
    if (rm.code !== 0) {
      fail(`Could not replace existing server '${f.name}': ${redactToken(rm.stderr || rm.stdout, realToken)}`);
    }
    removedExisting = true;
  }

  const add = deps.runClaude(buildClaudeMcpAddArgv({ name: f.name, url, headerToken: realToken }));
  if (add.code !== 0) {
    const note = removedExisting ? ` (note: the previous '${f.name}' was already removed — re-run to restore it)` : '';
    fail(`'claude mcp add' failed${note}: ${redactToken(add.stderr || add.stdout, realToken)}`);
  }
  console.error(`Added MCP server '${f.name}' -> ${url}.`);

  // D4 smoke-test: prove the token actually authenticates a tool call now,
  // instead of failing silently on the agent's first request.
  const probe = await deps.probe(url, realToken, f.timeoutMs);
  if (probe.ok) {
    console.error(`Verified: ${probe.identity || 'brain reachable'}`);
    console.error('');
    console.error(LEARN_INSTRUCTION);
    return;
  }
  // Server is registered, but end-to-end auth did not verify. Exit non-zero so
  // scripts notice; the message never echoes the token.
  console.error(
    `Warning: registered '${f.name}', but the smoke-test did not verify (${probe.reason}): ${redactToken(probe.message, realToken)}`,
  );
  console.error('The agent will likely hit 401/errors until the token or URL is fixed.');
  process.exit(1);
}
