// Copies the made-up team report the repository's demo tooling writes into
// the plugin, which bundles it as its example team: BB builds only files
// inside the plugin's folder. This vendored copy has no repository beside it,
// so the committed demo/team.json is kept as it is.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dir, "..");
const source = path.join(root, "../docs/demo/team.json");
if (existsSync(source)) {
  mkdirSync(path.join(root, "demo"), { recursive: true });
  copyFileSync(source, path.join(root, "demo/team.json"));
}
