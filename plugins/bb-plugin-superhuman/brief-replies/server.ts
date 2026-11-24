import type { BbPluginApi } from "@get-bb/plugin-sdk";

/** After Andrej Karpathy's advice to ask agents for ASD-STE100 Simplified Technical English. */
export const BRIEF_REPLIES_INSTRUCTIONS = `Write prose for the user about 80% of the way to ASD-STE100 Simplified Technical English:
- Sentences of 20 words or fewer, one idea each, active voice. Give instructions as commands.
- Plain words with one meaning; the same term for the same thing. Keep articles (a, the).
- When structure or flow matters, draw a small diagram instead of describing it.
Use the fewest words that carry the answer. No preamble, recap, filler, hedging, or offers of more help. Never cut failures, risks, or real uncertainty.`;

/** The part of the root settings handle that Brief Replies reads. */
interface BriefRepliesSettings {
  get(): Promise<{ briefReplies?: boolean }>;
  onChange(listener: (next: { briefReplies?: boolean }) => void): void;
}

/** BB reads the instructions when it starts an agent session, so a change reaches new sessions only. */
export default async function registerBriefRepliesServer(
  bb: BbPluginApi,
  settings: BriefRepliesSettings,
) {
  let on = (await settings.get()).briefReplies === true;
  settings.onChange((next) => {
    on = next.briefReplies === true;
  });
  bb.agents.contributeInstructions(() =>
    on ? BRIEF_REPLIES_INSTRUCTIONS : null,
  );
}
