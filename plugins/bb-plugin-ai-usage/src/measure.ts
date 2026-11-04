// Usage that ai-usage does not collect, measured on the machine where the
// login lives. Codex is the ChatGPT rate-limit endpoint. Copilot is the
// GitHub account stored by the Copilot app, not the gh CLI.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { quotaLogins } from "./local-providers.js";

export interface MeasuredWindow {
  name: string;
  /** 0–100, how much of the window is used. */
  percentUsed: number;
  resetsAt: string | null;
}

export interface MeasuredProvider {
  provider: string;
  name: string;
  plan: string | null;
  windows: MeasuredWindow[];
}

export interface MeasuredUsage {
  hostName: string;
  user: string;
  providers: MeasuredProvider[];
}

function windowName(seconds: number): string {
  if (seconds >= 20 * 86400) return "30d";
  if (seconds >= 6 * 86400) return "7d";
  if (seconds >= 4 * 3600) return "5h";
  return "limit";
}

/** The signed-in account, as ai-usage names it: the email's local part. A hostname is not an account. */
function accountName(token: string | undefined): string | null {
  const part = token?.split(".")[1];
  if (part === undefined || part === "") return null;
  try {
    const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as {
      email?: unknown;
      "https://api.openai.com/profile"?: { email?: unknown };
    };
    const email = typeof claims.email === "string" ? claims.email : claims["https://api.openai.com/profile"]?.email;
    if (typeof email !== "string") return null;
    const local = email.split("@")[0]?.trim() ?? "";
    return local === "" ? null : local;
  } catch {
    return null;
  }
}

async function codex(): Promise<MeasuredProvider | null> {
  const file = path.join(os.homedir(), ".codex", "auth.json");
  if (!existsSync(file)) return null;
  let auth: { tokens?: { access_token?: string; id_token?: string; account_id?: string } };
  try {
    auth = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  const token = auth.tokens?.access_token;
  const account = auth.tokens?.account_id;
  if (!token || !account) return null;
  // A stalled connection would hold the machine's answer forever, so the request has a limit.
  const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
    headers: { Authorization: `Bearer ${token}`, "ChatGPT-Account-Id": account, "User-Agent": "codex-cli" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) return null;
  const body = (await response.json()) as {
    plan_type?: string;
    rate_limit?: {
      primary_window?: { used_percent?: number; limit_window_seconds?: number; reset_at?: number };
      secondary_window?: { used_percent?: number; limit_window_seconds?: number; reset_at?: number } | null;
    };
  };
  const windows: MeasuredWindow[] = [];
  for (const item of [body.rate_limit?.primary_window, body.rate_limit?.secondary_window]) {
    if (item?.used_percent === undefined || !Number.isFinite(item.used_percent)) continue;
    const reset = item.reset_at && item.reset_at > 0 ? new Date(item.reset_at * 1000).toISOString() : null;
    windows.push({ name: windowName(item.limit_window_seconds ?? 0), percentUsed: item.used_percent, resetsAt: reset });
  }
  if (windows.length === 0) return null;
  const name = accountName(auth.tokens?.id_token) ?? accountName(auth.tokens?.access_token) ?? os.hostname();
  return { provider: "codex", name, plan: body.plan_type ?? null, windows };
}

function copilot(): MeasuredProvider | null {
  if (process.platform !== "win32") return null;
  const script = `
import ctypes, ctypes.wintypes, json, sqlite3, os, urllib.request
class CREDENTIAL(ctypes.Structure):
    _fields_ = [("Flags", ctypes.wintypes.DWORD), ("Type", ctypes.wintypes.DWORD), ("TargetName", ctypes.c_wchar_p), ("Comment", ctypes.c_wchar_p), ("LastWritten", ctypes.wintypes.FILETIME), ("CredentialBlobSize", ctypes.wintypes.DWORD), ("CredentialBlob", ctypes.POINTER(ctypes.c_byte)), ("Persist", ctypes.wintypes.DWORD), ("AttributeCount", ctypes.wintypes.DWORD), ("Attributes", ctypes.c_void_p), ("TargetAlias", ctypes.c_wchar_p), ("UserName", ctypes.c_wchar_p)]
adv = ctypes.windll.advapi32
account_id = None
db = os.path.expanduser(r"~/.copilot/data.db")
if os.path.exists(db):
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        row = con.execute("select id from accounts limit 1").fetchone()
        con.close()
        if row: account_id = row[0]
    except Exception:
        account_id = None
if not account_id:
    try:
        count = ctypes.wintypes.DWORD()
        arr = ctypes.POINTER(ctypes.POINTER(CREDENTIAL))()
        if adv.CredEnumerateW(None, 0, ctypes.byref(count), ctypes.byref(arr)):
            try:
                suffix = ".github-copilot-app"
                for i in range(int(count.value)):
                    target = arr[i].contents.TargetName or ""
                    if target.endswith(suffix):
                        account_id = target[:-len(suffix)]
                        break
            finally:
                adv.CredFree(arr)
    except Exception:
        account_id = None
if not account_id: raise SystemExit
pcred = ctypes.POINTER(CREDENTIAL)()
if not adv.CredReadW(account_id + ".github-copilot-app", 1, 0, ctypes.byref(pcred)): raise SystemExit
cred = pcred.contents
blob = ctypes.string_at(cred.CredentialBlob, cred.CredentialBlobSize)
adv.CredFree(pcred)
token = blob.decode("utf-16-le").strip("\\x00")
req = urllib.request.Request("https://api.github.com/copilot_internal/user", headers={"Authorization": "Bearer " + token, "User-Agent": "GitHubCopilotChat/0.26.7", "Accept": "application/json"})
with urllib.request.urlopen(req, timeout=20) as r:
    body = json.loads(r.read().decode())
snaps = body.get("quota_snapshots") or {}
windows = []
for name, snap in snaps.items():
    if not isinstance(snap, dict) or snap.get("unlimited") or not snap.get("has_quota"): continue
    entitlement = snap.get("entitlement") or 0
    if entitlement <= 0: continue
    remaining = snap.get("percent_remaining")
    used = 100 - remaining if isinstance(remaining, (int, float)) else None
    if used is None: continue
    windows.append({"name": name, "percentUsed": used, "resetsAt": body.get("quota_reset_date_utc")})
print(json.dumps({"plan": body.get("copilot_plan"), "login": body.get("login"), "windows": windows}))
`;
  let result: { status: number | null; stdout: string } | null = null;
  for (const bin of ["python", "py", "python3"]) {
    const run = spawnSync(bin, ["-c", script], { encoding: "utf8", timeout: 25_000, windowsHide: true });
    if (run.error) continue;
    result = run;
    break;
  }
  if (result === null || result.status !== 0 || !result.stdout.trim()) return null;
  let parsed: { plan?: string | null; login?: unknown; windows?: MeasuredWindow[] };
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  const login = typeof parsed.login === "string" ? parsed.login.trim() : "";
  const windows = (parsed.windows ?? []).filter((w) => Number.isFinite(w.percentUsed));
  if (login === "" || windows.length === 0) return null;
  return { provider: "copilot", name: login, plan: parsed.plan ?? null, windows };
}

const require = createRequire(import.meta.url);

function home(...parts: string[]): string {
  return path.join(os.homedir(), ...parts);
}

function dataHome(...parts: string[]): string {
  const root = process.env.XDG_DATA_HOME || home(".local", "share");
  return path.join(root, ...parts);
}

function firstFile(files: string[]): string | null {
  return files.find((file) => file !== "" && existsSync(file)) ?? null;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function localPart(email: string | null | undefined): string | null {
  const local = email?.split("@")[0]?.trim() ?? "";
  return local === "" ? null : local;
}

function findEmail(value: unknown, depth = 0): string | null {
  if (depth > 6) return null;
  if (typeof value === "string" && value.includes("@") && !value.includes(" ") && value.length < 180) return localPart(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findEmail(item, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/token|secret|password|refresh|access|api.?key|credential|authorization/i.test(key)) continue;
    const found = findEmail(item, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

function hasSecret(value: unknown, depth = 0): boolean {
  if (depth > 6 || value === null || typeof value !== "object") return false;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/token|secret|password|refresh|access|api.?key|credential/i.test(key)) {
      if (typeof item === "string" && item.trim() !== "") return true;
      if (hasSecret(item, depth + 1)) return true;
    } else if (hasSecret(item, depth + 1)) {
      return true;
    }
  }
  return false;
}

function fileLogin(provider: string, file: string): MeasuredProvider | null {
  const parsed = readJson(file);
  if (parsed === null || (!hasSecret(parsed) && findEmail(parsed) === null)) return null;
  return { provider, name: findEmail(parsed) ?? provider, plan: null, windows: [] };
}

function textHasSecret(file: string): boolean {
  try {
    return /^(api_key|apikey|token|access_token|refresh_token|openai_api_key)\s*[:=]\s*\S+/im.test(readFileSync(file, "utf8"));
  } catch {
    return false;
  }
}

function opencodeLogin(): MeasuredProvider | null {
  const auth = firstFile([
    dataHome("opencode", "auth.json"),
    home(".config", "opencode", "auth.json"),
    home("Library", "Application Support", "opencode", "auth.json"),
    process.env.APPDATA ? path.join(process.env.APPDATA, "opencode", "auth.json") : "",
  ]);
  if (auth !== null) {
    const parsed = readJson(auth);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const keys = Object.keys(record).filter((key) => key !== "github-copilot" && hasSecret(record[key]));
      if (keys.length > 0) return { provider: "opencode", name: findEmail(parsed) ?? keys[0] ?? "opencode", plan: null, windows: [] };
    }
  }
  const dbFile = firstFile([dataHome("opencode", "opencode.db"), home("Library", "Application Support", "opencode", "opencode.db")]);
  if (dbFile === null) return null;
  try {
    const { DatabaseSync } = require("node:sqlite") as {
      DatabaseSync: new (file: string, opts: { readOnly: boolean }) => {
        prepare(sql: string): { get(): { email?: string } | undefined };
        close(): void;
      };
    };
    const db = new DatabaseSync(dbFile, { readOnly: true });
    try {
      const row = db.prepare("SELECT email FROM account LIMIT 1").get();
      const name = typeof row?.email === "string" ? localPart(row.email) : null;
      return name === null ? null : { provider: "opencode", name, plan: null, windows: [] };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function addOpenClaw(parsed: unknown, gravity: string | undefined, add: (item: MeasuredProvider | null) => void): void {
  if (parsed === null || typeof parsed !== "object") return;
  const root = parsed as { profiles?: unknown; auth?: { profiles?: unknown } };
  const profiles = root.profiles ?? root.auth?.profiles;
  if (profiles === null || typeof profiles !== "object") return;
  for (const [key, value] of Object.entries(profiles as Record<string, unknown>)) {
    const profile = value !== null && typeof value === "object" ? (value as { provider?: unknown; email?: unknown }) : {};
    const providerId = typeof profile.provider === "string" ? profile.provider : (key.split(":")[0] ?? "");
    const email = typeof profile.email === "string" ? localPart(profile.email) : localPart(key.includes("@") ? key.split(":").slice(1).join(":") : null);
    if (providerId === "google-antigravity" || providerId === "antigravity") {
      if (gravity !== undefined && (email === null || email === gravity)) continue;
      add({ provider: "antigravity", name: email ?? "Gravity", plan: null, windows: [] });
      continue;
    }
    if (providerId === "github-copilot" || providerId === "copilot" || providerId === "") continue;
    const mapped = providerId === "opencode-go" ? "opencode" : providerId === "xai" ? "grok" : providerId;
    add({ provider: mapped, name: email ?? mapped, plan: null, windows: [] });
  }
}

/** Auth files for providers ai-usage does not measure. A Copilot token stored by another app is not a second subscription. */
// Gemini is not a subscription of its own here: its sign-in is Antigravity's, and Antigravity's card carries the Gemini limits.
export function otherLogins(have: MeasuredProvider[]): MeasuredProvider[] {
  const names = new Map(have.map((item) => [item.provider, item.name]));
  const out: MeasuredProvider[] = [];
  const add = (item: MeasuredProvider | null) => {
    if (item === null || item.name.trim() === "") return;
    if ([...have, ...out].some((known) => known.provider === item.provider && known.name === item.name)) return;
    out.push(item);
  };
  const specs: { provider: string; paths: string[] }[] = [
    { provider: "grok", paths: [home(".grok", "auth.json"), home(".config", "grok", "auth.json"), home(".grok", "credentials.json"), home(".xai", "auth.json"), home(".config", "xai", "auth.json")] },
    { provider: "hermes", paths: [home(".hermes", "auth.json"), home(".config", "hermes", "auth.json"), home(".hermes-agent", "auth.json")] },
    { provider: "pi", paths: [home(".pi", "agent", "auth.json"), home(".pi", "auth.json"), home(".config", "pi", "auth.json")] },
    { provider: "omp", paths: [home(".omp", "auth.json"), home(".config", "omp", "auth.json")] },
    { provider: "openai", paths: [home(".openai", "auth.json"), home(".config", "openai", "auth.json")] },
  ];
  for (const spec of specs) {
    const file = firstFile(spec.paths);
    if (file === null) continue;
    const item = fileLogin(spec.provider, file);
    if (item === null) continue;
    if (spec.provider === "openai" && names.has("codex") && (item.name === "openai" || item.name === names.get("codex"))) continue;
    add(item);
  }
  for (const file of [home(".hermes", "config.yaml"), home(".hermes", "config.yml"), home(".hermes", ".env")]) {
    if (textHasSecret(file)) {
      add({ provider: "hermes", name: "Hermes", plan: null, windows: [] });
      break;
    }
  }
  add(opencodeLogin());
  const claw = firstFile([home(".openclaw", "agents", "main", "agent", "auth-profiles.json"), home(".openclaw", "openclaw.json")]);
  if (claw !== null) addOpenClaw(readJson(claw), names.get("antigravity"), add);
  return out;
}

export async function measureUsage(): Promise<MeasuredUsage> {
  const providers: MeasuredProvider[] = [];
  const push = (item: MeasuredProvider | null) => {
    if (item !== null) providers.push(item);
  };
  try {
    push(await codex());
  } catch {
    // This machine has no readable Codex login.
  }
  try {
    push(copilot());
  } catch {
    // This machine has no readable Copilot login.
  }
  try {
    for (const item of quotaLogins()) push(item);
  } catch {
    // Cursor or Gravity did not answer on this machine.
  }
  try {
    for (const item of otherLogins(providers)) push(item);
  } catch {
    // A provider auth file was unreadable.
  }
  return { hostName: os.hostname(), user: os.userInfo().username, providers };
}
