// Cursor, Copilot, and Antigravity are not in `ai-usage report`. Each becomes
// one subscription on the page: the bars are what is left, and when it resets.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { stepLimit } from "./budget.js";
import type { MatrixCell, Report, Share, TeamAccount, Usage, Window } from "./report.js";

const require = createRequire(import.meta.url);

function openDb(file: string): { get(sql: string): Record<string, unknown> | undefined; close(): void } | null {
  if (!existsSync(file)) return null;
  try {
    const { DatabaseSync } = require("node:sqlite") as {
      DatabaseSync: new (path: string, opts: { readOnly: boolean }) => {
        prepare(sql: string): { get(): Record<string, unknown> | undefined };
        close(): void;
      };
    };
    const db = new DatabaseSync(file, { readOnly: true });
    return { get: (sql) => db.prepare(sql).get(), close: () => db.close() };
  } catch {
    return null;
  }
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function meter(name: string, percentUsed: number, resetsAt: string | null, main: boolean): Window {
  const state = percentUsed >= 100 ? "out" : percentUsed >= 80 ? "tight" : "ok";
  return {
    name,
    percent: percentUsed,
    resets_at: resetsAt,
    minutes: null,
    main,
    limits: true,
    stale: false,
    reset: false,
    unread: false,
    state,
    forecast: null,
  };
}

function card(name: string, device: string, windows: Window[], extra: Partial<TeamAccount> = {}): TeamAccount {
  const worst = windows.reduce((s, w) => (w.percent > s ? w.percent : s), 0);
  const state = windows.length === 0 ? (extra.state ?? "unknown") : worst >= 100 ? "out" : worst >= 80 ? "tight" : "ok";
  return {
    label: name,
    name,
    alias: extra.alias ?? null,
    subscription: true,
    current: true,
    devices: [device],
    plan: extra.plan ?? null,
    state,
    quota:
      windows.length === 0
        ? null
        : { observed_at: new Date().toISOString(), age_seconds: 0, stale: false, device, windows },
    sessions: 0,
    usage: { today: 0, "7d": 0, "30d": 0, "90d": 0 },
    burn: null,
    users: 1,
    busiest: null,
    last_active_at: null,
    no_reading: extra.no_reading ?? null,
    extra_usage: null,
  };
}

function copilot(device: string): TeamAccount | null {
  const gh = spawnSync(
    "gh",
    ["api", "/copilot_internal/user", "--jq", "{plan:.copilot_plan,reset:.quota_reset_date_utc,premium:.quota_snapshots.premium_interactions}"],
    { encoding: "utf8", timeout: 20_000, windowsHide: true },
  );
  if (gh.status !== 0 || !gh.stdout.trim()) return null;
  let parsed: { plan?: string; reset?: string; premium?: { credits_used?: number; entitlement?: number; unlimited?: boolean } };
  try {
    parsed = JSON.parse(gh.stdout);
  } catch {
    return null;
  }
  const premium = parsed.premium;
  if (premium == null) return null;
  const entitlement = num(premium.entitlement);
  const used = entitlement > 0 ? (num(premium.credits_used) / entitlement) * 100 : 0;
  return card("premium", device, [meter("premium", used, parsed.reset ?? null, true)], { plan: parsed.plan ?? null });
}

/**
 * A second GitHub account with its own Copilot seat, logged in with `gh` into its own config
 * folder ~/.config/gh-<key> (so the normal gh login is untouched). The key is also the suffix of
 * the bb agent id acp-github-copilot-<key>, which ties its threads' tokens to this account.
 */
export interface CopilotProfile {
  key: string;
  dir: string;
  login: string | null;
}

export function copilotProfiles(): CopilotProfile[] {
  const base = path.join(os.homedir(), ".config");
  let names: string[] = [];
  try {
    names = readdirSync(base);
  } catch {
    return [];
  }
  const out: CopilotProfile[] = [];
  for (const name of names.sort()) {
    if (!name.startsWith("gh-") || name.length <= 3) continue;
    const dir = path.join(base, name);
    const hosts = path.join(dir, "hosts.yml");
    if (!existsSync(hosts)) continue;
    let login: string | null = null;
    try {
      login = /^\s*user:\s*(\S+)/m.exec(readFileSync(hosts, "utf8"))?.[1] ?? null;
    } catch {
      login = null;
    }
    out.push({ key: name.slice(3), dir, login });
  }
  return out;
}

/** The Copilot quota of a profile's account, or null when it has no seat or gh cannot reach GitHub. */
export function copilotProfileQuota(profile: CopilotProfile): { name: string; plan: string | null; windows: Window[] } | null {
  const env: Record<string, string | undefined> = { ...process.env, GH_CONFIG_DIR: profile.dir };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  const limit = stepLimit(20_000);
  if (limit === null) return null;
  const run = spawnSync("gh", ["api", "/copilot_internal/user"], { encoding: "utf8", timeout: limit, windowsHide: true, env });
  if (run.status !== 0 || !run.stdout.trim()) return null;
  let body: {
    login?: string;
    copilot_plan?: string;
    quota_reset_date_utc?: string;
    quota_snapshots?: Record<string, { unlimited?: boolean; has_quota?: boolean; entitlement?: number; percent_remaining?: number } | undefined>;
  };
  try {
    body = JSON.parse(run.stdout);
  } catch {
    return null;
  }
  const name = (body.login ?? profile.login ?? "").trim();
  if (name === "") return null;
  const windows: Window[] = [];
  for (const [label, snap] of Object.entries(body.quota_snapshots ?? {})) {
    if (snap === undefined || snap.unlimited || !snap.has_quota || num(snap.entitlement) <= 0) continue;
    if (typeof snap.percent_remaining !== "number") continue;
    windows.push(meter(label, 100 - snap.percent_remaining, body.quota_reset_date_utc ?? null, windows.length === 0));
  }
  return windows.length === 0 ? null : { name, plan: body.copilot_plan ?? null, windows };
}

let cursorAt = 0;
let cursorCache: TeamAccount | null = null;

function curlBin(): string {
  return process.platform === "win32" ? "curl.exe" : "curl";
}

function cursorAuthFile(): string | null {
  const home = os.homedir();
  const files = [
    process.env.APPDATA ? path.join(process.env.APPDATA, "Cursor", "auth.json") : "",
    path.join(home, "Library", "Application Support", "Cursor", "auth.json"),
    path.join(home, ".config", "Cursor", "auth.json"),
    path.join(home, "AppData", "Roaming", "Cursor", "auth.json"),
  ];
  return files.find((file) => file !== "" && existsSync(file)) ?? null;
}

function cursorApi(token: string, method: string): Record<string, unknown> | null {
  const limit = stepLimit(20_000);
  if (limit === null) return null;
  const res = spawnSync(
    curlBin(),
    [
      "-sS",
      "-X",
      "POST",
      `https://api2.cursor.sh/aiserver.v1.DashboardService/${method}`,
      "-H",
      `Authorization: Bearer ${token}`,
      "-H",
      "Content-Type: application/json",
      "-H",
      "Connect-Protocol-Version: 1",
      "-d",
      "{}",
    ],
    { encoding: "utf8", timeout: limit, windowsHide: true },
  );
  if (res.status !== 0 || !res.stdout.trim() || res.stdout.includes("unauthenticated")) return null;
  try {
    const parsed = JSON.parse(res.stdout) as Record<string, unknown>;
    return typeof parsed.code === "string" ? null : parsed;
  } catch {
    return null;
  }
}

function cursor(device: string): TeamAccount {
  if (cursorCache !== null && Date.now() - cursorAt < 60_000) return { ...cursorCache, devices: [device] };
  const signedOut = card("Pro+", device, [], {
    no_reading: "Cursor's saved sign-in has expired, so what is left of the plan cannot be read. Sign in to Cursor again.",
  });
  const file = cursorAuthFile();
  if (file === null) return signedOut;
  let token = "";
  try {
    token = (JSON.parse(readFileSync(file, "utf8")) as { accessToken?: string }).accessToken ?? "";
  } catch {
    return signedOut;
  }
  if (token === "") return signedOut;
  const usage = cursorApi(token, "GetCurrentPeriodUsage");
  if (usage === null) return signedOut;
  const planUsage = (usage.planUsage ?? {}) as {
    includedSpend?: number;
    limit?: number;
    autoPercentUsed?: number;
    apiPercentUsed?: number;
    totalPercentUsed?: number;
  };
  const info = cursorApi(token, "GetPlanInfo");
  const planInfo = (info?.planInfo ?? {}) as { planName?: string };
  const endMs = Number(usage.billingCycleEnd);
  const resets = Number.isFinite(endMs) && endMs > 0 ? new Date(endMs).toISOString() : null;
  const windows: Window[] = [];
  if (Number.isFinite(planUsage.autoPercentUsed)) windows.push(meter("auto", planUsage.autoPercentUsed ?? 0, resets, windows.length === 0));
  if (Number.isFinite(planUsage.apiPercentUsed)) windows.push(meter("API", planUsage.apiPercentUsed ?? 0, resets, windows.length === 0));
  cursorAt = Date.now();
  cursorCache = card(planInfo.planName || "Pro+", device, windows, {
    no_reading: windows.length === 0 ? "Cursor did not return a limit." : null,
  });
  return cursorCache;
}

interface QuotaModel {
  id: string;
  left: number;
  reset: string | null;
}

let antigravityAt = 0;
let antigravityCache: TeamAccount | null = null;

function fields(buf: Buffer): { field: number; bytes?: Buffer; num?: number }[] {
  const out: { field: number; bytes?: Buffer; num?: number }[] = [];
  let i = 0;
  while (i < buf.length) {
    let key = 0;
    let shift = 0;
    while (i < buf.length) {
      const b = buf[i++]!;
      key |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    const field = key >> 3;
    const wire = key & 7;
    if (wire === 2) {
      let len = 0;
      shift = 0;
      while (i < buf.length) {
        const b = buf[i++]!;
        len |= (b & 0x7f) << shift;
        shift += 7;
        if ((b & 0x80) === 0) break;
      }
      out.push({ field, bytes: buf.subarray(i, i + len) });
      i += len;
    } else if (wire === 0) {
      let val = 0;
      shift = 0;
      while (i < buf.length) {
        const b = buf[i++]!;
        val |= (b & 0x7f) << shift;
        shift += 7;
        if ((b & 0x80) === 0) break;
      }
      out.push({ field, num: val });
    } else if (wire === 5) i += 4;
    else if (wire === 1) i += 8;
    else break;
  }
  return out;
}

function emailLocal(email: string | null | undefined): string | null {
  const local = email?.split("@")[0]?.trim() ?? "";
  return local === "" ? null : local;
}

function antigravityStateFile(): string | null {
  const home = os.homedir();
  const files = [
    process.env.APPDATA ? path.join(process.env.APPDATA, "Antigravity", "User", "globalStorage", "state.vscdb") : "",
    path.join(home, "Library", "Application Support", "Antigravity", "User", "globalStorage", "state.vscdb"),
    path.join(home, ".config", "Antigravity", "User", "globalStorage", "state.vscdb"),
    path.join(home, "AppData", "Roaming", "Antigravity", "User", "globalStorage", "state.vscdb"),
  ];
  return files.find((file) => file !== "" && existsSync(file)) ?? null;
}

/** %LOCALAPPDATA%, or its default under the profile on Windows when the variable is unset. */
function localAppData(): string | undefined {
  return process.env.LOCALAPPDATA ?? (process.platform === "win32" ? path.join(os.homedir(), "AppData", "Local") : undefined);
}

function antigravityPresent(): boolean {
  const home = os.homedir();
  const local = localAppData();
  const markers = [
    local === undefined ? "" : path.join(local, "Programs", "Antigravity", "Antigravity.exe"),
    local === undefined ? "" : path.join(local, "agy", "bin", "agy.exe"),
    "/Applications/Antigravity.app",
    path.join(home, "Applications", "Antigravity.app"),
    path.join(home, ".local", "bin", "agy"),
  ];
  return markers.some((file) => file !== "" && existsSync(file)) || antigravityStateFile() !== null;
}

function antigravityEmail(): string | null {
  const file = antigravityStateFile();
  if (file === null) return null;
  const db = openDb(file);
  if (db === null) return null;
  try {
    const raw = db.get("SELECT value FROM ItemTable WHERE key = 'antigravityAuthStatus'")?.value;
    if (typeof raw !== "string" || !raw.startsWith("{")) return null;
    const parsed = JSON.parse(raw) as { email?: unknown };
    return typeof parsed.email === "string" ? emailLocal(parsed.email) : null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** Gemini CLI stores the same Gravity sign-in in the Windows credential manager, not a file. */
function geminiCredential(): { email: string | null; access: string | null; refresh: string | null } | null {
  if (process.platform !== "win32") return null;
  const script = `
import ctypes, ctypes.wintypes, json
class CREDENTIAL(ctypes.Structure):
    _fields_ = [("Flags", ctypes.wintypes.DWORD), ("Type", ctypes.wintypes.DWORD), ("TargetName", ctypes.c_wchar_p), ("Comment", ctypes.c_wchar_p), ("LastWritten", ctypes.wintypes.FILETIME), ("CredentialBlobSize", ctypes.wintypes.DWORD), ("CredentialBlob", ctypes.POINTER(ctypes.c_byte)), ("Persist", ctypes.wintypes.DWORD), ("AttributeCount", ctypes.wintypes.DWORD), ("Attributes", ctypes.c_void_p), ("TargetAlias", ctypes.c_wchar_p), ("UserName", ctypes.c_wchar_p)]
adv = ctypes.windll.advapi32
pcred = ctypes.POINTER(CREDENTIAL)()
if not adv.CredReadW("gemini:antigravity", 1, 0, ctypes.byref(pcred)):
    raise SystemExit
cred = pcred.contents
blob = ctypes.string_at(cred.CredentialBlob, cred.CredentialBlobSize)
adv.CredFree(pcred)
data = json.loads(blob.decode("utf-8"))
token = data.get("token") or {}
print(json.dumps({"email": data.get("id_token_email"), "access": token.get("access_token"), "expiry": token.get("expiry")}))
`;
  const limit = stepLimit(15_000);
  if (limit === null) return null;
  let result: { status: number | null; stdout: string } | null = null;
  for (const bin of ["python", "py", "python3"]) {
    const run = spawnSync(bin, ["-c", script], { encoding: "utf8", timeout: limit, windowsHide: true });
    if (run.error) continue;
    result = run;
    break;
  }
  if (result === null || result.status !== 0 || !result.stdout.trim()) return null;
  try {
    const parsed = JSON.parse(result.stdout) as { email?: unknown; access?: unknown; expiry?: unknown };
    const email = typeof parsed.email === "string" ? emailLocal(parsed.email) : null;
    const access = typeof parsed.access === "string" && parsed.access !== "" ? parsed.access : null;
    const expiry = typeof parsed.expiry === "string" ? Date.parse(parsed.expiry) : NaN;
    const fresh = access !== null && (!Number.isFinite(expiry) || expiry > Date.now() + 30_000);
    return { email, access: fresh ? access : null, refresh: null };
  } catch {
    return null;
  }
}

/**
 * The Gravity sign-in as the macOS keychain stores it (service `gemini`, account `antigravity`).
 * `security -w` prints it as JSON, or as `go-keyring-base64:` plus base64 JSON, or as hex JSON.
 * The token is returned only to the caller; it is never printed.
 */
export function parseAgyCredential(text: string, now = Date.now()): { email: string | null; access: string | null; refresh: string | null } | null {
  let body = text.trim();
  if (body.startsWith("go-keyring-base64:")) body = Buffer.from(body.slice("go-keyring-base64:".length), "base64").toString("utf8");
  else if (/^(?:[0-9a-fA-F]{2})+$/.test(body)) body = Buffer.from(body, "hex").toString("utf8");
  let data: { token?: { access_token?: unknown; refresh_token?: unknown; expiry?: unknown }; id_token_email?: unknown };
  try {
    data = JSON.parse(body) as typeof data;
  } catch {
    return null;
  }
  const token = plainObject(data.token) ?? {};
  const access = typeof token.access_token === "string" && token.access_token !== "" ? token.access_token : null;
  const refresh = typeof token.refresh_token === "string" && token.refresh_token !== "" ? token.refresh_token : null;
  const expiry = typeof token.expiry === "string" ? Date.parse(token.expiry) : NaN;
  const fresh = access !== null && (!Number.isFinite(expiry) || expiry > now + 30_000);
  const email = typeof data.id_token_email === "string" ? emailLocal(data.id_token_email) : null;
  return { email, access: fresh ? access : null, refresh };
}

/** macOS: the keychain item the Gemini CLI and Antigravity write. A locked or denied item reads as null. */
function keychainCredential(): { email: string | null; access: string | null; refresh: string | null } | null {
  if (process.platform !== "darwin") return null;
  const limit = stepLimit(5_000);
  if (limit === null) return null;
  const run = spawnSync("security", ["find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"], {
    encoding: "utf8",
    timeout: limit,
    windowsHide: true,
  });
  if (run.status !== 0 || !run.stdout.trim()) return null;
  return parseAgyCredential(run.stdout);
}

let antigravityMail: string | null = null;
/** Why the last refresh gave no token, shown on the probe and the card's no-reading line. */
let antigravityWhy: string | null = null;

// The Google OAuth client for Antigravity's token refresh is not stored in git. It comes from
// env AI_USAGE_ANTIGRAVITY_CLIENT_ID / AI_USAGE_ANTIGRAVITY_CLIENT_SECRET, or from an untracked
// file: %LOCALAPPDATA%\ai-usage\antigravity-oauth.json on Windows, ~/.config/ai-usage/ elsewhere.
// The file is JSON: {"client_id": "...", "client_secret": "..."}. Missing config returns null,
// and the refresh is skipped so the card shows "no reading" instead of failing.
function antigravityOauthClient(): { clientId: string; clientSecret: string } | null {
  const envId = process.env.AI_USAGE_ANTIGRAVITY_CLIENT_ID?.trim() ?? "";
  const envSecret = process.env.AI_USAGE_ANTIGRAVITY_CLIENT_SECRET?.trim() ?? "";
  if (envId !== "" && envSecret !== "") return { clientId: envId, clientSecret: envSecret };
  const base = process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "ai-usage")
    : path.join(os.homedir(), ".config", "ai-usage");
  const file = path.join(base, "antigravity-oauth.json");
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { client_id?: unknown; client_secret?: unknown };
    const clientId = typeof parsed.client_id === "string" ? parsed.client_id.trim() : "";
    const clientSecret = typeof parsed.client_secret === "string" ? parsed.client_secret.trim() : "";
    return clientId !== "" && clientSecret !== "" ? { clientId, clientSecret } : null;
  } catch {
    return null;
  }
}

/** Trades a refresh token for an access token. Google's error code, never the body, is kept as the reason. */
function refreshAccess(refresh: string): string | null {
  const oauth = antigravityOauthClient();
  if (oauth === null) {
    antigravityWhy = "Antigravity token expired and no OAuth client is configured";
    return null;
  }
  const body = new URLSearchParams({
    client_id: oauth.clientId,
    client_secret: oauth.clientSecret,
    refresh_token: refresh,
    grant_type: "refresh_token",
  });
  const limit = stepLimit(20_000);
  if (limit === null) return null;
  const res = spawnSync("curl", ["-sS", "-X", "POST", "https://oauth2.googleapis.com/token", "-d", body.toString()], {
    encoding: "utf8",
    timeout: limit,
    windowsHide: true,
  });
  if (res.status !== 0 || !res.stdout.trim()) return null;
  try {
    const parsed = JSON.parse(res.stdout) as { access_token?: string; error?: unknown };
    if (typeof parsed.error === "string") antigravityWhy = `token refresh rejected (${parsed.error})`;
    return parsed.access_token ?? null;
  } catch {
    return null;
  }
}

function antigravityRefresh(): string | null {
  antigravityMail = antigravityEmail();
  antigravityWhy = null;
  const file = antigravityStateFile();
  const db = file === null ? null : openDb(file);
  let stored = "";
  if (db !== null) {
    try {
      stored = String(db.get("SELECT value FROM ItemTable WHERE key = 'antigravityUnifiedStateSync.oauthToken'")?.value ?? "");
    } finally {
      db.close();
    }
  }
  if (stored === "") {
    const cred = geminiCredential() ?? keychainCredential();
    if (cred === null) return null;
    if (antigravityMail === null) antigravityMail = cred.email;
    if (cred.access !== null) return cred.access;
    return cred.refresh === null ? null : refreshAccess(cred.refresh);
  }
  const outer = fields(Buffer.from(stored, "base64"));
  const wrapper = outer.find((f) => f.field === 1)?.bytes;
  if (wrapper === undefined) return null;
  const payload = fields(wrapper).find((f) => f.field === 2)?.bytes;
  if (payload === undefined) return null;
  const encoded = fields(payload).find((f) => f.field === 1)?.bytes?.toString("utf8") ?? "";
  const refresh = fields(Buffer.from(encoded, "base64")).find((f) => f.field === 3)?.bytes?.toString("utf8") ?? "";
  if (refresh === "") return null;
  return refreshAccess(refresh);
}

function postJson(url: string, token: string): unknown {
  const limit = stepLimit(20_000);
  if (limit === null) return null;
  const res = spawnSync(
    "curl",
    ["-sS", "-X", "POST", url, "-H", `Authorization: Bearer ${token}`, "-H", "Content-Type: application/json", "-H", "User-Agent: antigravity", "-d", "{}"],
    { encoding: "utf8", timeout: limit, windowsHide: true },
  );
  if (res.status !== 0 || !res.stdout.trim()) return null;
  try {
    return JSON.parse(res.stdout);
  } catch {
    return null;
  }
}

function family(id: string): string | null {
  if (id.startsWith("chat_") || id.startsWith("tab_")) return null;
  if (id.startsWith("gemini")) return "Gemini";
  if (id.startsWith("claude")) return "Claude";
  if (id.startsWith("gpt")) return "GPT";
  return null;
}

/** A quota bucket from retrieveUserQuota. Only these fields are read. */
export interface GravityBucket {
  modelId?: string;
  remainingFraction?: number;
  resetTime?: string;
  /** Set when the payload itself says this window is used up. */
  exhausted?: boolean;
}

function isArgon(id: string): boolean {
  const key = id.toLowerCase();
  return key === "argon" || key.endsWith("-argon") || key.includes("argon");
}

/** Every model with a meter: the Gemini, Claude and GPT families, and Argon. chat_ and tab_ are dropped. */
function kept(id: string): boolean {
  if (id.startsWith("chat_") || id.startsWith("tab_")) return false;
  return family(id) !== null || isArgon(id);
}

function markedExhausted(bucket: GravityBucket): boolean {
  if (bucket.exhausted === true) return true;
  const extra = bucket as GravityBucket & Record<string, unknown>;
  for (const [key, value] of Object.entries(extra)) {
    if (value === true && /exhaust|expired|depleted/i.test(key)) return true;
  }
  return false;
}

function resetPast(resetTime: string | undefined, now: number): boolean {
  if (resetTime === undefined || resetTime === "") return false;
  const at = Date.parse(resetTime);
  return Number.isFinite(at) && at <= now;
}

/**
 * Used up when the payload says so: remainingFraction 0, an exhausted mark, or a reset time with no
 * remainingFraction at all (Google's proto3 JSON omits zero values). Argon also counts as used up
 * once its reset time has passed; other models use their reported fraction.
 */
function exhausted(bucket: GravityBucket, now: number, argon: boolean): boolean {
  return (
    bucket.remainingFraction === 0 ||
    (typeof bucket.remainingFraction !== "number" && !!bucket.resetTime) ||
    (argon && resetPast(bucket.resetTime, now)) ||
    markedExhausted(bucket)
  );
}

function usedPercent(fraction: number | undefined): number | null {
  if (typeof fraction !== "number" || !Number.isFinite(fraction)) return null;
  return Math.max(0, Math.min(100, (1 - fraction) * 100));
}

const EFFORT_SUFFIX = /-(low|medium|high|xhigh|max)$/;
const EFFORT_NAME_SUFFIX = /\s+\((low|medium|high|xhigh|max)\)$/i;
const FAMILY_ORDER = ["Gemini", "Claude", "GPT"];

/** "claude-opus-5-5" is "Claude Opus 5.5", "gpt-oss-120b" is "GPT-OSS 120B". */
function humanize(id: string): string {
  const out: string[] = [];
  for (const token of id.split("-")) {
    const last = out[out.length - 1];
    if (/^\d/.test(token)) {
      if (last !== undefined && /^\d+(\.\d+)*$/.test(last)) out[out.length - 1] = `${last}.${token}`;
      else out.push(token.toUpperCase());
    } else if (last === "GPT") {
      out[out.length - 1] = `GPT-${token.toUpperCase()}`;
    } else if (token === "gpt") {
      out.push("GPT");
    } else {
      out.push(token.charAt(0).toUpperCase() + token.slice(1));
    }
  }
  return out.join(" ");
}

interface Model {
  key: string;
  family: string;
  /** How far up its family the model is: 0 is not a frontier candidate. */
  tier: number;
  version: number[];
}

/**
 * The version of a model id as integers, in order: "claude-opus-5-5" is [5, 5], "gemini-3.10-pro" is
 * [3, 10], so 3.10 is newer than 3.8. Parameter counts such as "120b" are not versions.
 */
function versionOf(id: string): number[] {
  return (id.replace(/\d+b\b/gi, "").match(/\d+/g) ?? []).map(Number);
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? -1;
    const y = b[i] ?? -1;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/**
 * Gemini's tiers, within its newest generation: Argon, then Pro, then Flash. Lite and Image models
 * are not frontier. Claude's frontier is Opus. Every GPT model is a candidate.
 */
function modelOf(key: string): Model | null {
  const fam = family(key) ?? (isArgon(key) ? "Gemini" : null);
  if (fam === null) return null;
  let tier = 1;
  if (fam === "Gemini") tier = /(^|-)(lite|image)(-|$)/.test(key) ? 0 : isArgon(key) ? 3 : /(^|-)pro(-|$)/.test(key) ? 2 : 1;
  else if (fam === "Claude") tier = /(^|-)opus(-|$)/.test(key) ? 1 : 0;
  // An Argon id with no version number is the current one, so it is the newest generation.
  const version = versionOf(key);
  return { key, family: fam, tier, version: version.length === 0 && isArgon(key) ? [Infinity] : version };
}

/**
 * Per family, the frontier models: for Gemini only the newest generation present, then the highest
 * tier, then the highest version (ties all kept). An older generation is never picked over a newer one.
 */
function frontierKeys(models: readonly Model[]): Set<string> {
  const out = new Set<string>();
  for (const fam of new Set(models.map((m) => m.family))) {
    let group = models.filter((m) => m.family === fam && m.tier > 0);
    if (group.length === 0) continue;
    if (fam === "Gemini") {
      const newest = group.reduce((a, b) => (compareVersions(b.version, a.version) > 0 ? b : a)).version;
      group = group.filter((m) => compareVersions(m.version, newest) === 0);
    }
    const top = Math.max(...group.map((m) => m.tier));
    const tiered = group.filter((m) => m.tier === top);
    const best = tiered.reduce((a, b) => (compareVersions(b.version, a.version) > 0 ? b : a));
    for (const m of tiered) if (compareVersions(m.version, best.version) === 0) out.add(m.key);
  }
  return out;
}

/**
 * One meter per model. Effort variants (`-low`, `-max`, ...) share a meter and show the worst of
 * them, with that bucket's reset. `names` maps a model id to its display name. Only the frontier
 * model of each family is shown, plus any other model that is used up. A real Argon row comes first,
 * then the frontier rows before the used-up ones, most used first; then Gemini, Claude, GPT, then the
 * rest. The first window is main.
 */
export function gravityWindows(buckets: readonly GravityBucket[], now = Date.now(), names: ReadonlyMap<string, string> = new Map()): Window[] {
  const groups = new Map<string, { ids: string[]; used: number; reset: string | null }>();
  for (const bucket of buckets) {
    const id = bucket.modelId ?? "";
    if (!kept(id)) continue;
    const used = exhausted(bucket, now, isArgon(id)) ? 100 : usedPercent(bucket.remainingFraction);
    if (used === null) continue;
    const key = id.replace(EFFORT_SUFFIX, "");
    const reset = bucket.resetTime || null;
    const prev = groups.get(key);
    if (prev === undefined) groups.set(key, { ids: [id], used, reset });
    else {
      prev.ids.push(id);
      if (used > prev.used) {
        prev.used = used;
        prev.reset = reset;
      }
    }
  }
  const models = [...groups.keys()].map(modelOf).filter((m): m is Model => m !== null);
  const frontier = frontierKeys(models);
  const entries = [...groups.entries()]
    .map(([key, group]) => {
      const named = group.ids.map((id) => names.get(id)).find((name) => name !== undefined);
      // The "-tiered" suffix is an internal tier marker, not part of the model's name.
      const label = named === undefined ? humanize(key.replace(/-tiered$/, "")) : named.replace(EFFORT_NAME_SUFFIX, "").trim();
      const rank = FAMILY_ORDER.indexOf(family(key) ?? "");
      return { key, label, ...group, rank: rank === -1 ? FAMILY_ORDER.length : rank, frontier: frontier.has(key) };
    })
    .filter((entry) => entry.frontier || entry.used >= 100);
  const labelCount = new Map<string, number>();
  for (const entry of entries) labelCount.set(entry.label, (labelCount.get(entry.label) ?? 0) + 1);
  // Unique labels claim their name first. A duplicated label falls back to the model id, and any
  // name already taken gets a numeric suffix, so every window name is unique.
  const taken = new Set<string>();
  const claimed = new Map<string, string>();
  const claim = (key: string, base: string) => {
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base} (${n})`;
    taken.add(name);
    claimed.set(key, name);
  };
  for (const entry of entries) if (labelCount.get(entry.label) === 1) claim(entry.key, entry.label);
  for (const entry of entries) if ((labelCount.get(entry.label) ?? 0) > 1) claim(entry.key, entry.key);
  const sorted = entries
    .map((entry) => ({ ...entry, name: claimed.get(entry.key) ?? entry.key }))
    .sort(
      (a, b) =>
        Number(isArgon(b.key)) - Number(isArgon(a.key)) ||
        Number(b.frontier) - Number(a.frontier) ||
        b.used - a.used ||
        a.rank - b.rank ||
        a.name.localeCompare(b.name),
    );
  return sorted.map((entry, i) => meter(entry.name, entry.used, entry.reset, i === 0));
}

/**
 * The shared Claude & GPT limits from retrieveUserQuotaSummary: the 5-hour and weekly buckets of each
 * group that has them. A bucket with no readable fraction is skipped, never shown as a made-up number.
 */
export function gravitySummaryWindows(raw: unknown, now = Date.now()): Window[] {
  const groups = plainObject(raw)?.groups;
  if (!Array.isArray(groups)) return [];
  const names: Record<string, string> = { "3p-5h": "5-hour", "3p-weekly": "weekly" };
  const out: Window[] = [];
  for (const group of groups) {
    const buckets = plainObject(group)?.buckets;
    if (!Array.isArray(buckets)) continue;
    for (const item of buckets) {
      const bucket = plainObject(item) as (GravityBucket & { bucketId?: unknown }) | null;
      const kind = typeof bucket?.bucketId === "string" ? names[bucket.bucketId] : undefined;
      if (bucket === null || kind === undefined) continue;
      const used = exhausted(bucket, now, false) ? 100 : usedPercent(bucket.remainingFraction);
      if (used === null) continue;
      const resetTime = typeof bucket.resetTime === "string" && bucket.resetTime !== "" ? bucket.resetTime : null;
      out.push(meter(`Claude & GPT · ${kind}`, used, resetTime, false));
    }
  }
  return out;
}

/** One row of `agy -p "/quota"`: a category, a limit's label, the share left, and when it resets. */
export interface AgyRow {
  category: string;
  label: string;
  remaining: number;
  resetsAt: string | null;
}

const AGY_CATEGORY_NAMES: Record<string, string> = { "Gemini Models": "Gemini", "Claude and GPT models": "Claude & GPT" };
const AGY_KIND_NAMES: Record<string, string> = { "five hour": "5-hour" };

/**
 * The rows of `agy -p "/quota"`: tab-separated category, label, "NN%" left, and an ISO reset time.
 * Any other line is ignored, and a row whose reset time is unreadable keeps its percentage.
 */
export function parseAgyQuota(text: string): AgyRow[] {
  const rows: AgyRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const [category = "", label = "", percent = "", reset = ""] = line.split("\t").map((cell) => cell.trim());
    const match = /^(\d{1,3}(?:\.\d+)?)%$/.exec(percent);
    if (category === "" || label === "" || match === null) continue;
    const remaining = Number(match[1]);
    if (remaining > 100) continue;
    const resetsAt = PROBE_TIME.test(reset) && Number.isFinite(Date.parse(reset)) ? reset : null;
    rows.push({ category, label, remaining, resetsAt });
  }
  return rows;
}

/** A row's window name part: its label without "Remaining" and "Limit" and the category, as "weekly" or "5-hour". */
function agyKind(category: string, label: string): string {
  let rest = label.replace(/\s+Remaining$/i, "").replace(/\s+Limit$/i, "").trim();
  if (rest.toLowerCase().startsWith(category.toLowerCase())) rest = rest.slice(category.length).trim();
  const key = rest.toLowerCase();
  return AGY_KIND_NAMES[key] ?? (key === "" ? label : key);
}

/**
 * The windows of `agy -p "/quota"`, one per category and limit. Argon's rows come first, then the
 * categories in the order agy prints them, and each category's 5-hour limit before its weekly one.
 * The Argon row is 100 minus the share left, and the first Argon row is main. A repeated name is dropped.
 */
export function gravityAgyWindows(rows: readonly AgyRow[]): Window[] {
  const seen = new Set<string>();
  const entries: { name: string; used: number; reset: string | null; argon: boolean; category: number; rank: number }[] = [];
  for (const row of rows) {
    const kind = agyKind(row.category, row.label);
    const name = `${AGY_CATEGORY_NAMES[row.category] ?? row.category} · ${kind}`;
    if (seen.has(name)) continue;
    seen.add(name);
    entries.push({
      name,
      used: 100 - row.remaining,
      reset: row.resetsAt,
      argon: isArgon(row.category),
      category: rows.findIndex((r) => r.category === row.category),
      rank: kind === "5-hour" ? 0 : kind === "weekly" ? 1 : 2,
    });
  }
  entries.sort((a, b) => Number(b.argon) - Number(a.argon) || a.category - b.category || a.rank - b.rank);
  return entries.map((e, i) => meter(e.name, e.used, e.reset, i === 0 && e.argon));
}

/**
 * The Gravity card's windows: agy's rows first, then retrieveUserQuota's per-model rows, then the shared
 * Claude & GPT rows. When agy gave an Argon row it replaces retrieveUserQuota's Argon rows and is main,
 * and a shared row that agy already gave is dropped.
 */
export function joinGravityWindows(agy: readonly Window[], models: readonly Window[], shared: readonly Window[]): Window[] {
  const argon = agy.some((w) => /argon/i.test(w.name));
  const names = new Set(agy.map((w) => w.name));
  return [
    ...agy,
    ...models.filter((w) => !(argon && /argon/i.test(w.name))).map((w) => (argon ? { ...w, main: false } : w)),
    ...shared.filter((w) => !names.has(w.name)),
  ];
}

/** `agy -p "/quota"` on this machine, as text. It prints the limits without a model turn. Empty when agy is missing, fails, or takes over 20s. */
function agyQuotaText(): string {
  const limit = stepLimit(20_000);
  if (limit === null) return "";
  const home = os.homedir();
  const local = localAppData();
  const candidates = [path.join(home, ".local", "bin", "agy"), local === undefined ? "" : path.join(local, "agy", "bin", "agy.exe")];
  const bin = candidates.find((file) => file !== "" && existsSync(file)) ?? "agy";
  const run = spawnSync(bin, ["-p", "/quota"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: limit, windowsHide: true });
  if (run.error !== undefined || run.status !== 0) return "";
  return String(run.stdout ?? "");
}

/** Display names from the live model list. Best effort: a failed call leaves the names humanized. */
function gravityNames(token: string): Map<string, string> {
  const names = new Map<string, string>();
  const models = postJson("https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels", token) as {
    models?: Record<string, { displayName?: unknown } | null>;
  } | null;
  const table = models?.models;
  if (table === null || typeof table !== "object") return names;
  for (const [id, item] of Object.entries(table)) {
    const name = item?.displayName;
    if (typeof name === "string" && name.trim() !== "") names.set(id, name.trim());
  }
  return names;
}

const PROBE_ID = /^[A-Za-z0-9._-]{1,80}$/;
const PROBE_NAME = /^[A-Za-z0-9 ._()-]{1,80}$/;
const PROBE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;
const PROBE_FLAG = /exhaust|expired|depleted/i;
const REDACTED = "[redacted]";

function plainObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** A field name as a probe shows it. Only plain identifiers pass, so a value cannot hide in a name. */
function fieldName(key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(key) ? key : "[name]";
}

/** The value when it matches the pattern, else redacted. Absent stays null. */
function probeText(value: unknown, pattern: RegExp): string | null {
  if (value === undefined) return null;
  return typeof value === "string" && pattern.test(value) ? value : REDACTED;
}

function probeFraction(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The diagnostic fields of one quota bucket: model id, fraction, reset time, and boolean flags
 * that say exhausted. Every other field is listed by name only, with its value redacted.
 */
function probeBucket(value: unknown): Record<string, unknown> {
  const item = plainObject(value);
  if (item === null) return { value: REDACTED };
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(item)) {
    if (key === "modelId") out[key] = probeText(field, PROBE_ID);
    else if (key === "resetTime") out[key] = probeText(field, PROBE_TIME);
    else if (key === "remainingFraction" && probeFraction(field) !== null) out[key] = field;
    else if (typeof field === "boolean" && PROBE_FLAG.test(key)) out[key] = field;
    else out[fieldName(key)] = REDACTED;
  }
  return out;
}

/** The shape of a retrieveUserQuota reply, with every value outside the allowlist redacted. */
export function probeQuota(raw: unknown): unknown {
  const root = plainObject(raw);
  if (root === null) return REDACTED;
  return {
    fields: Object.keys(root).map(fieldName),
    buckets: Array.isArray(root.buckets) ? root.buckets.map(probeBucket) : root.buckets === undefined ? null : REDACTED,
  };
}

/** The shape of a fetchAvailableModels reply: display names, model ids and quota fields only. */
export function probeModels(raw: unknown): unknown {
  const root = plainObject(raw);
  if (root === null) return { models: REDACTED };
  const fields = Object.keys(root).map(fieldName);
  const table = plainObject(root.models);
  if (table === null) return { fields };
  return {
    fields,
    models: Object.entries(table).map(([id, value]) => {
      const item = plainObject(value) ?? {};
      const quota = plainObject(item.quotaInfo) ?? {};
      return {
        id: probeText(id, PROBE_ID),
        displayName: probeText(item.displayName, PROBE_NAME),
        fields: Object.keys(item).map(fieldName),
        quotaFields: Object.keys(quota).map(fieldName),
        remainingFraction: probeFraction(quota.remainingFraction),
        resetTime: probeText(quota.resetTime, PROBE_TIME),
      };
    }),
  };
}

/** The live model list, with every value outside the allowlist redacted. */
export function gravityBucketProbe(): unknown {
  const token = antigravityRefresh();
  if (token === null) return null;
  const models = postJson("https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels", token);
  if (models === null || typeof models !== "object") return { models: null };
  return probeModels(models);
}

/** The raw quota buckets from retrieveUserQuota, with every value outside the allowlist redacted. */
export function gravityQuotaProbe(): unknown {
  const token = antigravityRefresh();
  if (token === null) return null;
  const quota = postJson("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota", token);
  return quota === null ? null : probeQuota(quota);
}

const SUMMARY_KEY = /^(id|name|title|displayName|modelId|bucketId|groupId|label|type|kind|period|window|scope|group|bucket)$/i;
const SUMMARY_NUMBER_KEY = /fraction|percent|remain|used|limit|minute|second|count|usage|quota|total/i;

/**
 * The shape of a retrieveUserQuotaSummary reply: every field name, and values only where they are
 * safe to show (ids and names under known keys, reset times, flags). Other numbers show as a
 * placeholder unless the key names a quota figure; other strings are redacted.
 */
export function probeSummary(raw: unknown, key = "", depth = 0): unknown {
  if (depth > 8) return REDACTED;
  if (Array.isArray(raw)) return raw.slice(0, 20).map((item) => probeSummary(item, key, depth + 1));
  const object = plainObject(raw);
  if (object !== null) {
    const out: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(object)) out[fieldName(name)] = probeSummary(value, name, depth + 1);
    return out;
  }
  if (typeof raw === "number") return SUMMARY_NUMBER_KEY.test(key) ? raw : "[number]";
  if (typeof raw === "boolean" || raw === null) return raw;
  if (typeof raw === "string") {
    if (PROBE_TIME.test(raw)) return raw;
    if (SUMMARY_KEY.test(key)) return probeText(raw, PROBE_NAME) ?? REDACTED;
    return REDACTED;
  }
  return REDACTED;
}

/** The raw retrieveUserQuotaSummary reply, reduced by probeSummary. */
export function gravitySummaryProbe(): unknown {
  const token = antigravityRefresh();
  if (token === null) return null;
  const summary = postJson("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", token);
  return summary === null ? null : probeSummary(summary);
}

/** Why the last Antigravity read gave no token, for the probe; null when a token was found or none was tried. */
export function gravityReason(): string | null {
  return antigravityWhy;
}

const ANTIGRAVITY_SIGNED_OUT = "Antigravity is installed, but its sign-in could not be read.";

function antigravity(device: string): TeamAccount | null {
  if (antigravityCache !== null && Date.now() - antigravityAt < 5 * 60_000) return { ...antigravityCache, devices: [device] };
  const token = antigravityRefresh();
  const email = antigravityMail;
  const agy = gravityAgyWindows(parseAgyQuota(agyQuotaText()));
  if (token === null && email === null && agy.length === 0) {
    if (!antigravityPresent()) return null;
    antigravityAt = Date.now();
    antigravityCache = card("Antigravity", device, [], { no_reading: ANTIGRAVITY_SIGNED_OUT });
    return antigravityCache;
  }
  const quota = (token === null ? null : postJson("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota", token)) as {
    buckets?: GravityBucket[];
  } | null;
  const plan = (token === null ? null : postJson("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", token)) as {
    paidTier?: { name?: string };
    currentTier?: { name?: string };
  } | null;
  const names = token === null ? new Map<string, string>() : gravityNames(token);
  const summary = token === null ? null : postJson("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", token);
  const buckets = quota?.buckets;
  const windows = joinGravityWindows(agy, gravityWindows(Array.isArray(buckets) ? buckets : [], Date.now(), names), gravitySummaryWindows(summary));
  const planName = plan?.paidTier?.name || plan?.currentTier?.name || null;
  const label = email ?? planName ?? "Gravity";
  antigravityAt = Date.now();
  antigravityCache = card(label, device, windows, {
    plan: planName !== null && planName !== label ? planName : null,
    no_reading: windows.length === 0 ? "Gravity is signed in, but it did not return a limit." : null,
  });
  return antigravityCache;
}

function emptyUsage(): Usage {
  return { today: 0, "7d": 0, "30d": 0, "90d": 0 };
}

function emptyShare(): Share {
  return { today: null, "7d": null, "30d": null, "90d": null };
}

function emptyCell(): MatrixCell {
  return { usage: emptyUsage(), burn: null, share: emptyShare(), burn_share: null };
}

function withDevice(devices: string[], device: string): string[] {
  return devices.includes(device) ? devices : [...devices, device];
}

/**
 * A connected machine is a matrix row even when it has no token series.
 * A row already named for that host keeps its numbers and records this
 * machine's id. A new row uses the same empty cells as a seat with no
 * series, so the table shows the en dash. `aliases` are other names the machine's
 * own ai-usage reports under (its OS hostname), so its row is not listed twice.
 */
export function machineInMatrix(report: Report, hostName: string, user: string, deviceId: string, aliases: string[] = []): void {
  const hostKeys = new Set([hostName, ...aliases].map((name) => name.toLowerCase()).filter((name) => name !== ""));
  const known = report.team.matrix.rows.find((row) => {
    const device = row.device.toLowerCase();
    const at = device.lastIndexOf("@");
    const hostPart = at === -1 ? device : device.slice(at + 1);
    return hostKeys.has(hostPart) || row.device_id === deviceId;
  });
  if (known !== undefined) {
    known.device_id = deviceId;
    return;
  }
  const label = user !== "" ? `${user}@${hostName}` : hostName;
  report.team.matrix.rows.push({
    device: label,
    device_id: deviceId,
    cells: report.team.matrix.columns.map(() => emptyCell()),
    usage: emptyUsage(),
    burn: null,
    share: emptyShare(),
    burn_share: null,
    burn_estimated: false,
  });
}

/**
 * Copilot and Cursor get a column even before token counts arrive. Every Copilot
 * seat shares that one column; a second account does not add another. Cursor's
 * numbers come from composer rows, not from Burn. Antigravity is not an empty
 * seat: a Gravity column with no counted tokens would be only dashes.
 */
function seatInMatrix(report: Report, provider: string, name: string, state: string): void {
  if (provider !== "copilot" && provider !== "cursor") return;
  const columns = report.team.matrix.columns;
  const sameSeat = (c: { provider: string; name: string }) => c.provider === provider && (provider === "copilot" || c.name === name);
  if (!columns.some(sameSeat)) {
    columns.push({
      provider,
      label: null,
      name,
      no_quota: false,
      state,
      percent: null,
      usage: emptyUsage(),
      burn: null,
    });
  }
  for (const row of report.team.matrix.rows) {
    while (row.cells.length < columns.length) row.cells.push(emptyCell());
  }
}

/** The displayed percent, so 8 and 8.4 are one reading and 8 and 9 are not. */
function shownPercent(percent: number): number {
  return Math.floor(percent);
}

function resetInstant(at: string | null): string {
  if (at === null || at === "") return "";
  const t = Date.parse(at);
  return Number.isFinite(t) ? String(t) : at;
}

/** Same plan, same windows, same displayed percent, and the same reset instant. */
function quotaSignature(plan: string | null, windows: { name: string; percent: number; resets_at: string | null }[]): string {
  const body = windows
    .map((w) => `${w.name}\0${shownPercent(w.percent)}\0${resetInstant(w.resets_at)}`)
    .sort()
    .join("|");
  return `${(plan ?? "").trim().toLowerCase()}\0${body}`;
}

function sameQuota(plan: string | null, windows: Window[], account: TeamAccount): boolean {
  if (account.quota === null || account.quota.windows.length === 0) return false;
  return quotaSignature(plan, windows) === quotaSignature(account.plan, account.quota.windows);
}

/**
 * Whether two account names are one login: equal, or a bare login and the email with that local part.
 * Two addresses match only when they are equal, so a@x.com and a@y.com are different logins.
 */
function sameLoginName(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (x === "" || y === "") return false;
  if (x === y) return true;
  const isEmail = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
  if (isEmail(x) && !y.includes("@")) return x.slice(0, x.indexOf("@")) === y;
  if (isEmail(y) && !x.includes("@")) return y.slice(0, y.indexOf("@")) === x;
  return false;
}

/** Hostnames this report already uses as machine names. An account title that matches one is not a login. */
function hostLabels(report: Report, hostName: string): Set<string> {
  const out = new Set<string>();
  const add = (value: string | null | undefined) => {
    const text = value?.trim().toLowerCase() ?? "";
    if (text !== "") out.add(text);
  };
  add(hostName);
  for (const device of report.team.devices) {
    add(device.name);
    add(device.label);
    add(device.device);
    const at = device.name.lastIndexOf("@");
    if (at !== -1) add(device.name.slice(at + 1));
  }
  return out;
}

/**
 * One quota can arrive once under the real account and again under a hostname.
 * Keep the login. Drop the extra cost row, and do not change the dollar total.
 */
function foldCost(report: Report, provider: string, keepName: string, dropName: string): void {
  const cost = report.cost;
  if (cost === null || keepName === dropName) return;
  const isDrop = (name: string, account: string) => name === dropName || account === dropName;
  const drops = cost.subscriptions.filter((s) => s.provider === provider && isDrop(s.name, s.account));
  if (drops.length === 0) return;
  const keep = cost.subscriptions.find((s) => s.provider === provider && (s.name === keepName || s.account === keepName));
  const remove = (sub: (typeof drops)[number]) => {
    const index = cost.subscriptions.indexOf(sub);
    if (index === -1) return;
    cost.subscriptions.splice(index, 1);
    if (sub.price_usd === null) cost.without_price = Math.max(0, cost.without_price - 1);
  };
  if (keep === undefined) {
    const [first, ...rest] = drops;
    if (first === undefined) return;
    first.name = keepName;
    first.account = keepName;
    for (const extra of rest) {
      if (extra.price_usd !== first.price_usd) continue;
      if (extra.plan_name && first.plan_name && extra.plan_name.toLowerCase() !== first.plan_name.toLowerCase()) continue;
      remove(extra);
    }
    return;
  }
  for (const extra of drops) {
    if (extra.price_usd !== keep.price_usd) continue;
    if (extra.plan_name && keep.plan_name && extra.plan_name.toLowerCase() !== keep.plan_name.toLowerCase()) continue;
    remove(extra);
  }
}

/** A seat with no list price counts in the cost line and does not change the dollar total. */
function seatInCost(report: Report, provider: string, name: string, plan: string | null): void {
  const cost = report.cost;
  if (cost === null || provider !== "copilot") return;
  if (cost.subscriptions.some((s) => s.provider === provider && (s.name === name || s.account === name))) return;
  cost.subscriptions.push({
    provider,
    account: name,
    name,
    alias: null,
    plan_name: plan,
    price_usd: null,
    state: "active",
    renews_at: null,
  });
  cost.without_price += 1;
}

/** The cost line was an estimate that the whole subscription was spent, which contradicted the weekly limit. */
export function alignCost(report: Report): void {
  const cost = report.cost;
  if (cost === null || !cost.used_estimated || cost.used_pct === null) return;
  const main = report.team.providers
    .flatMap((p) => p.accounts)
    .flatMap((a) => a.quota?.windows ?? [])
    .find((w) => w.main);
  if (main === undefined || Math.abs(cost.used_pct - main.percent) < 25) return;
  cost.used_pct = null;
  cost.used_usd = null;
  cost.unused_usd = null;
}

export interface HostLogin {
  provider: string;
  name: string;
  plan: string | null;
  windows: { name: string; percentUsed: number; resetsAt: string | null }[];
}

function asLogin(provider: string, account: TeamAccount): HostLogin {
  return {
    provider,
    name: account.name,
    plan: account.plan,
    windows: (account.quota?.windows ?? []).map((window) => ({ name: window.name, percentUsed: window.percent, resetsAt: window.resets_at })),
  };
}

/** Cursor and Gravity logins on this machine. A signed-out install is not a login. */
export function quotaLogins(): HostLogin[] {
  const device = os.hostname();
  const out: HostLogin[] = [];
  if (cursorAuthFile() !== null) {
    const account = cursor(device);
    if ((account.quota?.windows.length ?? 0) > 0) out.push(asLogin("cursor", account));
  }
  const gravity = antigravity(device);
  if (gravity !== null && !(gravity.name === "Antigravity" && (gravity.quota?.windows.length ?? 0) === 0)) out.push(asLogin("antigravity", gravity));
  return out;
}

/** The host part of a device name such as user@host, lower-cased. */
function hostOf(name: string): string {
  const label = name.toLowerCase();
  const at = label.lastIndexOf("@");
  return at === -1 ? label : label.slice(at + 1);
}

/**
 * A machine that does not run the collector still contributes the logins that live on it.
 *
 * A reading is matched to a device by host name only (its BB name, or a name the machine reports
 * under, given as `aliases`). Never by OS user: several machines often share one.
 *
 * With `measuredAt`, the reading is an earlier one kept for a machine that is offline or whose live
 * reading failed. Its device says when it was last seen, and its logins are marked stale with that
 * time. Each login keeps whichever quota was read last, so a snapshot never replaces a newer reading.
 */
export function mergeMeasured(
  report: Report,
  measured: { hostName: string; user: string; providers: { provider: string; name: string; plan: string | null; windows: { name: string; percentUsed: number; resetsAt: string | null }[] }[] },
  options: { measuredAt?: number; aliases?: string[] } = {},
): void {
  const deviceName = measured.hostName;
  const stale = options.measuredAt !== undefined && Number.isFinite(options.measuredAt);
  const at = stale ? options.measuredAt! : 0;
  const seenAt = stale ? new Date(at).toISOString() : null;
  const ageSeconds = stale ? Math.max(0, Math.round((Date.now() - at) / 1000)) : 0;
  const names = new Set([deviceName, ...(options.aliases ?? [])].map((name) => name.toLowerCase()).filter((name) => name !== ""));
  const known = report.team.devices.find((d) => names.has(hostOf(d.name)) || names.has((d.label ?? "").toLowerCase()));
  if (known === undefined) {
    report.team.devices.push({
      device: deviceName,
      label: deviceName,
      os_user: measured.user,
      name: deviceName,
      this_device: false,
      collector_version: "",
      collected_at: seenAt ?? new Date().toISOString(),
      age_seconds: ageSeconds,
      error: null,
      silent: false,
      old: stale,
      usage: emptyUsage(),
      burn: null,
      note: stale ? `${measured.user}, last seen ${seenAt}` : measured.user,
      pooled: [],
    });
  } else if (stale) {
    // The report's own device keeps its newer reading; only one older than the snapshot is marked.
    const reported = Date.parse(known.collected_at ?? "");
    if (!Number.isFinite(reported) || reported < at) {
      known.old = true;
      known.collected_at = seenAt!;
      known.age_seconds = ageSeconds;
      known.note = `${measured.user}, last seen ${seenAt}`;
    }
  } else if (known.note === null || known.note === "") {
    known.note = measured.user;
  }
  const shownOn = known?.name || deviceName;
  const hosts = hostLabels(report, deviceName);
  for (const provider of measured.providers) {
    if (provider.name.trim() === "") continue;
    const windows = provider.windows.map((w, i) => meter(w.name, w.percentUsed, w.resetsAt, i === 0));
    const account = card(provider.name, shownOn, windows, {
      plan: provider.plan,
      no_reading: windows.length === 0 ? "Signed in. No limit reading yet." : null,
    });
    if (stale && account.quota !== null) {
      account.quota.stale = true;
      account.quota.age_seconds = ageSeconds;
      account.quota.observed_at = seenAt!;
    }
    const remember = () => {
      if (windows.length === 0) return;
      seatInMatrix(report, provider.provider, account.name, account.state);
      seatInCost(report, provider.provider, account.name, provider.plan);
    };
    const group = report.team.providers.find((p) => p.provider === provider.provider);
    if (group === undefined) {
      report.team.providers.push({ provider: provider.provider, accounts: [account] });
      remember();
      continue;
    }
    const incomingIsHost = hosts.has(provider.name.toLowerCase());
    const sameLogin = (a: TeamAccount) => !incomingIsHost && [a.name, a.label].some((name) => !hosts.has(name.toLowerCase()) && sameLoginName(provider.name, name));
    const candidates = group.accounts.filter((a) => a.name === account.name || sameLogin(a) || (windows.length > 0 && sameQuota(provider.plan, windows, a)));
    // The login wins over a machine name when both describe one quota.
    const existing = candidates.find((a) => !hosts.has(a.name.toLowerCase())) ?? candidates[0];
    if (existing === undefined) {
      group.accounts.push(account);
      remember();
      continue;
    }
    // A hostname repeating a quota already shown under a login is not a second subscription.
    if (hosts.has(existing.name.toLowerCase()) && !hosts.has(provider.name.toLowerCase())) {
      const previous = existing.name;
      existing.name = provider.name;
      existing.label = provider.name;
      foldCost(report, provider.provider, provider.name, previous);
    }
    if (provider.name !== existing.name) foldCost(report, provider.provider, existing.name, provider.name);
    // The freshest reading wins: a live one is read now, a snapshot when it was taken. On a tie, live beats stale.
    const incomingAt = stale ? at : Date.now();
    const parsed = Date.parse(existing.quota?.observed_at ?? "");
    const existingAt = Number.isFinite(parsed) ? parsed : -Infinity;
    const wins = windows.length > 0 && (incomingAt > existingAt || (incomingAt === existingAt && !stale && existing.quota?.stale === true));
    const unchanged = windows.length > 0 && sameQuota(provider.plan, windows, existing);
    if (wins && account.quota !== null) {
      if (unchanged && existing.quota !== null) {
        // The same numbers, read later: keep the windows and take the newer time.
        Object.assign(existing.quota, { observed_at: account.quota.observed_at, age_seconds: account.quota.age_seconds, stale: account.quota.stale, device: account.quota.device });
      } else {
        existing.quota = account.quota;
        existing.plan = account.plan ?? existing.plan;
        existing.state = account.state;
      }
    }
    existing.devices = withDevice(existing.devices, shownOn);
    group.accounts = group.accounts.filter((other) => {
      if (other === existing) return true;
      if (!sameQuota(provider.plan, windows, other)) return true;
      if (!hosts.has(other.name.toLowerCase())) return true;
      foldCost(report, provider.provider, existing.name, other.name);
      return false;
    });
    if (windows.length > 0) {
      seatInMatrix(report, provider.provider, existing.name, existing.state);
      seatInCost(report, provider.provider, existing.name, provider.plan);
    }
  }
}
