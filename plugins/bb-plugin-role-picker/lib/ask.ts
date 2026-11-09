// bb roles ask: the AskUserQuestion schema for agents without BB plugin tools (GitHub Copilot),
// mapped to the question-form payload the "ask" pending-interaction renderer in app.tsx shows.
import { z } from "zod";

export const ASK_RENDERER_ID = "ask";
export const ASK_TIMEOUT_MS = 30 * 60_000;
const MAX_HEADER_LENGTH = 12;
const MAX_PREVIEW_LENGTH = 4096;
// requestInput caps payloads at 64 KiB.
const MAX_PAYLOAD_BYTES = 60 * 1024;

const nonBlank = (what: string) => z.string().refine((value) => value.trim().length > 0, `${what} cannot be blank`);

const askOptionSchema = z.strictObject({
  label: nonBlank("label"),
  description: nonBlank("description"),
  preview: z.string().max(MAX_PREVIEW_LENGTH).optional(),
});

const askQuestionSchema = z.strictObject({
  question: nonBlank("question"),
  header: nonBlank("header").refine((value) => value.length <= MAX_HEADER_LENGTH, `header must be at most ${MAX_HEADER_LENGTH} characters`),
  options: z.array(askOptionSchema).min(2, "needs 2-4 options").max(4, "needs 2-4 options"),
  multiSelect: z.boolean().default(false),
});

const askInputSchema = z.strictObject({
  questions: z.array(askQuestionSchema).min(1, "needs 1-10 questions").max(10, "needs 1-10 questions"),
});

export type AskInput = z.infer<typeof askInputSchema>;

export type AskPayload = {
  questions: {
    id: string;
    prompt: string;
    shortLabel: string;
    multiSelect: boolean;
    allowFreeText: boolean;
    required: boolean;
    options: { value: string; label: string; description: string; preview?: string }[];
  }[];
};

export const ASK_SCHEMA_HINT =
  'Expected {"questions":[{"question":"...?","header":"<=12 chars","options":[{"label":"...","description":"..."}, ...2-4],"multiSelect":false}, ...1-10]}.';

export type AskSource = { kind: "inline"; json: string } | { kind: "file"; path: string };

/**
 * The ask arguments as one input source. The bb CLI rewrites --questions-stdin to --questions <stdin line>
 * before the plugin runs, so the plugin only sees --questions-stdin from a bb CLI without that rewrite.
 */
export function parseAskArgs(args: string[]): { ok: true; source: AskSource } | { ok: false; error: string } {
  const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--questions-stdin") {
      return { ok: false, error: "--questions-stdin reached the plugin unread: this bb CLI does not pipe stdin to plugin options. Update bb, or use --questions-file <path>." };
    }
    const match = /^--(questions|questions-file)(?:=(.*))?$/s.exec(args[i]);
    if (!match) return { ok: false, error: `Unknown argument "${args[i]}". Use --questions-stdin (JSON on stdin), --questions '<json>', or --questions-file <path>.` };
    const value = match[2] ?? args[++i];
    if (value === undefined) return { ok: false, error: `--${match[1]} needs a value.` };
    if (options[match[1]] !== undefined) return { ok: false, error: `--${match[1]} was given twice.` };
    options[match[1]] = value;
  }
  if ((options.questions === undefined) === (options["questions-file"] === undefined)) {
    return { ok: false, error: `bb roles ask needs exactly one of --questions-stdin (JSON on stdin), --questions '<json>', or --questions-file <path>. ${ASK_SCHEMA_HINT}` };
  }
  return options.questions !== undefined ? { ok: true, source: { kind: "inline", json: options.questions } } : { ok: true, source: { kind: "file", path: options["questions-file"] } };
}

/** The questions JSON parsed and checked against the AskUserQuestion schema, or every problem found. */
export function parseAskInput(raw: string): { ok: true; input: AskInput } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    return { ok: false, error: `The questions are not valid JSON: ${error instanceof Error ? error.message : String(error)}. ${ASK_SCHEMA_HINT}` };
  }
  const parsed = askInputSchema.safeParse(json);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.length ? issue.path.join(".") : "input"}: ${issue.message}`);
    return { ok: false, error: `Invalid questions:\n${problems.map((p) => `- ${p}`).join("\n")}\n${ASK_SCHEMA_HINT}` };
  }
  const problems: string[] = [];
  const prompts = parsed.data.questions.map((q) => q.question);
  if (new Set(prompts).size !== prompts.length) problems.push("questions: each question text must be unique");
  parsed.data.questions.forEach((q, index) => {
    const labels = q.options.map((option) => option.label);
    if (new Set(labels).size !== labels.length) problems.push(`questions.${index}.options: option labels must be unique`);
  });
  if (problems.length) return { ok: false, error: `Invalid questions:\n${problems.map((p) => `- ${p}`).join("\n")}` };
  if (Buffer.byteLength(JSON.stringify(buildAskPayload(parsed.data))) > MAX_PAYLOAD_BYTES) {
    return { ok: false, error: `The questions are too large to display (limit ${MAX_PAYLOAD_BYTES} bytes). Shorten them or drop the option previews.` };
  }
  return { ok: true, input: parsed.data };
}

export function buildAskPayload(input: AskInput): AskPayload {
  return {
    questions: input.questions.map((q, index) => ({
      id: `q${index + 1}`,
      prompt: q.question,
      shortLabel: q.header,
      multiSelect: q.multiSelect,
      allowFreeText: true,
      required: true,
      options: q.options.map((option) => ({
        value: option.label,
        label: option.label,
        description: option.description,
        // The form shows previews only for single-select questions.
        ...(option.preview?.trim() && !q.multiSelect ? { preview: option.preview } : {}),
      })),
    })),
  };
}

export function askTitle(input: AskInput): string {
  return input.questions[0]?.header ?? "Question";
}

export interface AskAnswer {
  question: string;
  header: string;
  selected: string[];
  freeText?: string;
}

/** The submitted form value, {answers: {q1: {selected, freeText?}}}, as one answer per question in order. */
export function askAnswers(payload: AskPayload, value: unknown): AskAnswer[] {
  const answers = value && typeof value === "object" && "answers" in value ? (value as { answers: unknown }).answers : undefined;
  const byId = answers && typeof answers === "object" ? (answers as Record<string, unknown>) : {};
  return payload.questions.map((q) => {
    const raw = byId[q.id];
    const entry = raw && typeof raw === "object" ? (raw as { selected?: unknown; freeText?: unknown }) : {};
    const selected = Array.isArray(entry.selected) ? entry.selected.filter((s): s is string => typeof s === "string") : [];
    const freeText = typeof entry.freeText === "string" && entry.freeText.trim() ? entry.freeText : undefined;
    return { question: q.prompt, header: q.shortLabel, selected, ...(freeText !== undefined ? { freeText } : {}) };
  });
}

export function formatAskOutput(answers: AskAnswer[]): string {
  return JSON.stringify({ answers }) + "\n";
}

function answerText(answer: AskAnswer): string {
  const parts = [...answer.selected, ...(answer.freeText !== undefined ? [answer.freeText] : [])];
  return parts.length ? parts.join("; ") : "no answer";
}

/** The timeline row a submitted card leaves behind. */
export function describeAsk(answers: AskAnswer[]): { title: string; detail: string } {
  const [first] = answers;
  const title = answers.length === 1 && first ? `Answered ${first.header}: ${answerText(first)}` : `Answered ${answers.length} questions`;
  const detail = answers.map((answer) => `- ${answer.question} — ${answerText(answer)}`).join("\n");
  return { title, detail };
}

export function askCancelledMessage(reason: string): string {
  return `The question was not answered (reason: ${reason}): the user dismissed the card, or it timed out or was interrupted. Ask the question in chat instead and end your turn.\n`;
}
