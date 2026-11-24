// Thread Board's settings. The board itself reads BB's live thread list in
// the page, so the server only defines what the page reads.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default function plugin(bb: BbPluginApi): void {
  bb.settings.define({
    showBoard: {
      type: "boolean",
      label: "Show the board",
      description: "Under the message box on the New thread screen.",
      default: true,
    },
    doneDays: {
      type: "number",
      label: "Done threads, days",
      description: "How many days a finished thread stays in the done column.",
      default: 3,
    },
  });
}
