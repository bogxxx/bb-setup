import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { subagentsCommand } from "./src/cli";
import { rpcContract } from "./src/contract";
import { loadSubagentDetail } from "./src/detail";
import { listSubagents } from "./src/roster";

export { rpcContract };

export default async function plugin(bb: BbPluginApi) {
  bb.rpc.register(rpcContract, {
    listSubagents({ threadId }) {
      return listSubagents(bb.sdk, threadId);
    },
    subagentDetail(input) {
      return loadSubagentDetail(bb.sdk, input);
    },
  });

  bb.events.on("experimental_thread.events", ({ thread, sequence }) => {
    if (thread.providerId === "claude-code") {
      bb.realtime.publish("thread-events", { threadId: thread.id, sequence });
    }
  });

  bb.cli.register(
    subagentsCommand({
      list: (threadId) => listSubagents(bb.sdk, threadId),
      show: (threadId, familyId) => loadSubagentDetail(bb.sdk, { threadId, familyId }),
    }),
  );
}
