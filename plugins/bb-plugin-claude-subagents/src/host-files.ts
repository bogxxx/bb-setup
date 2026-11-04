import type { BbPluginApi } from "@get-bb/plugin-sdk";

type Sdk = BbPluginApi["sdk"];

export type HostText = {
  text: string;
  sha256: string;
  sizeBytes: number;
  modifiedAtMs: number | null;
  path: string;
};

export type ReadResult =
  | { ok: true; file: HostText }
  | { ok: false; missing: boolean; message: string };

const sessionDirs = new Map<string, string>();

export async function readHostText(sdk: Sdk, hostId: string, filePath: string): Promise<ReadResult> {
  try {
    const file = await sdk.files.read({ hostId, path: filePath });
    if (!("content" in file) || typeof file.content !== "string") {
      return { ok: false, missing: false, message: "Transcript file could not be read" };
    }
    const text = file.contentEncoding === "base64" ? Buffer.from(file.content, "base64").toString("utf8") : file.content;
    if (file.sizeBytes === 0 || text.length === 0) {
      return { ok: false, missing: true, message: "Transcript file not found" };
    }
    return {
      ok: true,
      file: {
        text,
        sha256: file.sha256,
        sizeBytes: file.sizeBytes,
        modifiedAtMs: typeof file.modifiedAtMs === "number" ? file.modifiedAtMs : null,
        path: file.path,
      },
    };
  } catch (error) {
    const message = clip(error instanceof Error && error.message ? error.message : "Could not read the transcript file", 500);
    return { ok: false, missing: /not found|ENOENT|404|no such file/i.test(message), message };
  }
}

export function rememberSessionDirectory(hostId: string, sessionId: string, directory: string): void {
  sessionDirs.set(cacheKey(hostId, sessionId), directory);
}

export async function discoverSessionDirectory(
  sdk: Sdk,
  hostId: string,
  projectsPath: string,
  sessionId: string,
): Promise<string | null> {
  const key = cacheKey(hostId, sessionId);
  const cached = sessionDirs.get(key);
  if (cached) return cached;
  try {
    const listed = await sdk.files.listPaths({
      hostId,
      path: projectsPath,
      query: sessionId,
      includeDirectories: true,
      includeFiles: false,
      limit: 20,
    });
    const directory = listed.paths.find((entry) => entry.name === sessionId)?.path;
    if (!directory) return null;
    sessionDirs.set(key, directory);
    return directory;
  } catch {
    return null;
  }
}

function cacheKey(hostId: string, sessionId: string): string {
  return `${hostId}\0${sessionId}`;
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}
