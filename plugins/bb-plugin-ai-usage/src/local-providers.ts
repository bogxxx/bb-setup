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

function antigravityPresent(): boolean {
  const home = os.homedir();
  const markers = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "Antigravity", "Antigravity.exe") : "",
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "agy", "bin", "agy.exe") : "",
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
function geminiCredential(): { email: string | null; access: string | null } | null {
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
    return { email, access: fresh ? access : null };
  } catch {
    return null;
  }
}

let antigravityMail: string | null = null;

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

function antigravityRefresh(): string | null {
  antigravityMail = antigravityEmail();
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
    const cred = geminiCredential();
    if (cred === null) return null;
    if (antigravityMail === null) antigravityMail = cred.email;
    return cred.access;
  }
  const outer = fields(Buffer.from(stored, "base64"));
  const wrapper = outer.find((f) => f.field === 1)?.bytes;
  if (wrapper === undefined) return null;
  const payload = fields(wrapper).find((f) => f.field === 2)?.bytes;
  if (payload === undefined) return null;
  const encoded = fields(payload).find((f) => f.field === 1)?.bytes?.toString("utf8") ?? "";
  const refresh = fields(Buffer.from(encoded, "base64")).find((f) => f.field === 3)?.bytes?.toString("utf8") ?? "";
  if (refresh === "") return null;
  const oauth = antigravityOauthClient();
  if (oauth === null) return null;
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
    const parsed = JSON.parse(res.stdout) as { access_token?: string };
    return parsed.access_token ?? null;
  } catch {
    return null;
  }
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

function safeValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    if (value.length > 80 || value.includes("@") || /\s/.test(value)) return `[string ${value.length}]`;
    return value;
  }
  if (depth >= 3 || typeof value !== "object") return `[${typeof value}]`;
  if (Array.isArray(value)) return value.slice(0, 8).map((item) => safeValue(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/token|secret|auth|email|credential/i.test(key)) continue;
    out[key] = safeValue(item, depth + 1);
  }
  return out;
}

/** Shape of the live model list, with secrets removed. */
export function gravityBucketProbe(): unknown {
  const token = antigravityRefresh();
  if (token === null) return null;
  const models = postJson("https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels", token);
  if (models === null || typeof models !== "object") return { models: null };
  const root = models as Record<string, unknown>;
  const table = root.models;
  if (table === null || typeof table !== "object" || Array.isArray(table)) return { top: Object.keys(root), models: safeValue(models) };
  const rows = Object.entries(table as Record<string, unknown>).map(([id, value]) => {
    const item = value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
    const quota = item.quotaInfo !== null && typeof item.quotaInfo === "object" ? (item.quotaInfo as Record<string, unknown>) : {};
    return {
      id,
      keys: Object.keys(item).sort(),
      remainingFraction: typeof quota.remainingFraction === "number" ? quota.remainingFraction : null,
      resetTime: typeof quota.resetTime === "string" ? quota.resetTime : null,
      quotaKeys: Object.keys(quota).sort(),
    };
  });
  return { top: Object.keys(root), rows };
}

const ANTIGRAVITY_SIGNED_OUT = "Antigravity is installed, but its sign-in could not be read.";

function antigravity(device: string): TeamAccount | null {
  if (antigravityCache !== null && Date.now() - antigravityAt < 5 * 60_000) return { ...antigravityCache, devices: [device] };
  const token = antigravityRefresh();
  const email = antigravityMail;
  if (token === null && email === null) {
    if (!antigravityPresent()) return null;
    antigravityAt = Date.now();
    antigravityCache = card("Antigravity", device, [], { no_reading: ANTIGRAVITY_SIGNED_OUT });
    return antigravityCache;
  }
  const quota = (token === null ? null : postJson("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota", token)) as {
    buckets?: { modelId?: string; remainingFraction?: number; resetTime?: string }[];
  } | null;
  const plan = (token === null ? null : postJson("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", token)) as {
    paidTier?: { name?: string };
    currentTier?: { name?: string };
  } | null;
  const groups = new Map<string, { used: number; reset: string | null }>();
  for (const bucket of quota?.buckets ?? []) {
    const name = family(bucket.modelId ?? "");
    if (name === null || bucket.remainingFraction === undefined) continue;
    const used = Math.max(0, Math.min(100, (1 - bucket.remainingFraction) * 100));
    const prev = groups.get(name);
    if (prev === undefined || used > prev.used) groups.set(name, { used, reset: bucket.resetTime ?? prev?.reset ?? null });
    else if (prev.reset === null && bucket.resetTime) prev.reset = bucket.resetTime;
  }
  const order = ["Gemini", "Claude", "GPT"];
  const names = [...groups.keys()].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const same =
    names.length > 1 &&
    names.every((name) => {
      const item = groups.get(name);
      const first = groups.get(names[0] ?? "");
      return item !== undefined && first !== undefined && Math.abs(item.used - first.used) < 1 && item.reset === first.reset;
    });
  const windows = same
    ? [meter(names.join(", "), groups.get(names[0] ?? "")?.used ?? 0, groups.get(names[0] ?? "")?.reset ?? null, true)]
    : names.map((name) => meter(name, groups.get(name)?.used ?? 0, groups.get(name)?.reset ?? null, name === names[0]));
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
 * A seat with no token series still gets its column, so it is visible: Copilot and Cursor have
 * no token series here. Their cells stay empty and show the en dash; the quota is on the card.
 */
function seatInMatrix(report: Report, provider: string, name: string, state: string): void {
  if (provider !== "copilot" && provider !== "cursor") return;
  const columns = report.team.matrix.columns;
  if (!columns.some((c) => c.provider === provider && c.name === name)) {
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
 * time. Anything read at or after `measuredAt` is kept as it is.
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
    const candidates = group.accounts.filter((a) => a.name === account.name || (windows.length > 0 && sameQuota(provider.plan, windows, a)));
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
    // A stale reading never overwrites a quota read at or after it was taken.
    const newer = stale && existing.quota !== null && Date.parse(existing.quota.observed_at) >= at;
    const unchanged = windows.length > 0 && sameQuota(provider.plan, windows, existing);
    if (windows.length > 0 && !unchanged && !newer) {
      existing.quota = account.quota;
      existing.plan = account.plan ?? existing.plan;
      existing.state = account.state;
    }
    if (!newer) existing.devices = withDevice(existing.devices, shownOn);
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
