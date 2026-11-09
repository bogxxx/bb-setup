import { describe, expect, test } from "bun:test";
import { askAnswers, askCancelledMessage, askTitle, buildAskPayload, describeAsk, formatAskOutput, parseAskInput } from "../lib/ask";

const option = (label: string) => ({ label, description: `${label} description` });
const question = (overrides: Record<string, unknown> = {}) => ({
  question: "Which database?",
  header: "Database",
  options: [option("Postgres"), option("SQLite")],
  ...overrides,
});
const raw = (questions: unknown[]) => JSON.stringify({ questions });

function parsed(questions: unknown[]) {
  const result = parseAskInput(raw(questions));
  if (!result.ok) throw new Error(result.error);
  return result.input;
}

function error(input: string): string {
  const result = parseAskInput(input);
  if (result.ok) throw new Error("expected invalid input");
  return result.error;
}

describe("parseAskInput", () => {
  test("accepts the AskUserQuestion schema and defaults multiSelect to false", () => {
    const input = parsed([question({ options: [option("A"), option("B"), { ...option("C"), preview: "x" }] })]);
    expect(input.questions[0].multiSelect).toBe(false);
    expect(input.questions[0].options).toHaveLength(3);
  });

  test("rejects text that is not JSON", () => {
    expect(error("{questions:")).toContain("not valid JSON");
  });

  test("rejects 0 or 11 questions", () => {
    expect(error(raw([]))).toContain("questions: needs 1-10 questions");
    const eleven = Array.from({ length: 11 }, (_, i) => question({ question: `Q${i}?` }));
    expect(error(raw(eleven))).toContain("needs 1-10 questions");
  });

  test("rejects 1 or 5 options", () => {
    expect(error(raw([question({ options: [option("A")] })]))).toContain("questions.0.options: needs 2-4 options");
    const five = ["A", "B", "C", "D", "E"].map(option);
    expect(error(raw([question({ options: five })]))).toContain("needs 2-4 options");
  });

  test("rejects a header longer than 12 characters", () => {
    expect(error(raw([question({ header: "Thirteen chrs" })]))).toContain("questions.0.header: header must be at most 12 characters");
    expect(parsed([question({ header: "Twelve chars" })]).questions[0].header).toBe("Twelve chars");
  });

  test("rejects missing and blank fields and unknown keys, listing each problem", () => {
    const message = error(raw([{ question: " ", header: "H", options: [{ label: "A" }, option("B")], multiselect: true }]));
    expect(message).toContain("questions.0.question: question cannot be blank");
    expect(message).toContain("questions.0.options.0.description");
    expect(message).toContain("multiselect");
    expect(message).toContain('Expected {"questions"');
  });

  test("rejects duplicate questions and duplicate option labels", () => {
    expect(error(raw([question(), question()]))).toContain("each question text must be unique");
    expect(error(raw([question({ options: [option("A"), option("A")] })]))).toContain("questions.0.options: option labels must be unique");
  });

  test("rejects a payload too large for the card", () => {
    const big = "x".repeat(4000);
    const questions = Array.from({ length: 10 }, (_, i) =>
      question({ question: `Q${i}?`, options: ["A", "B", "C", "D"].map((l) => ({ ...option(l), preview: big })) }),
    );
    expect(error(raw(questions))).toContain("too large");
  });
});

describe("buildAskPayload", () => {
  test("maps to question-form questions: ids q1.., header as shortLabel, label as value, free text, required", () => {
    const input = parsed([question(), question({ question: "Which colors?", header: "Colors", multiSelect: true, options: [{ ...option("Red"), preview: "p" }, option("Blue")] })]);
    expect(buildAskPayload(input)).toEqual({
      questions: [
        {
          id: "q1",
          prompt: "Which database?",
          shortLabel: "Database",
          multiSelect: false,
          allowFreeText: true,
          required: true,
          options: [
            { value: "Postgres", label: "Postgres", description: "Postgres description" },
            { value: "SQLite", label: "SQLite", description: "SQLite description" },
          ],
        },
        {
          id: "q2",
          prompt: "Which colors?",
          shortLabel: "Colors",
          multiSelect: true,
          allowFreeText: true,
          required: true,
          // Previews show only on single-select questions.
          options: [
            { value: "Red", label: "Red", description: "Red description" },
            { value: "Blue", label: "Blue", description: "Blue description" },
          ],
        },
      ],
    });
  });

  test("keeps a preview on a single-select option", () => {
    const input = parsed([question({ options: [{ ...option("A"), preview: "code" }, option("B")] })]);
    expect(buildAskPayload(input).questions[0].options[0].preview).toBe("code");
  });

  test("the title is the first header", () => {
    expect(askTitle(parsed([question(), question({ question: "Other?", header: "Other" })]))).toBe("Database");
  });
});

describe("answers", () => {
  const payload = buildAskPayload(parsed([question(), question({ question: "Which colors?", header: "Colors", multiSelect: true, options: [option("Red"), option("Blue")] })]));

  test("prints one answer per question in order, with free text only when given", () => {
    const value = { answers: { q2: { selected: ["Red", "Blue"], freeText: "and green" }, q1: { selected: ["Postgres"] } } };
    const output = formatAskOutput(askAnswers(payload, value));
    expect(output.endsWith("\n")).toBe(true);
    expect(JSON.parse(output)).toEqual({
      answers: [
        { question: "Which database?", header: "Database", selected: ["Postgres"] },
        { question: "Which colors?", header: "Colors", selected: ["Red", "Blue"], freeText: "and green" },
      ],
    });
  });

  test("a missing or malformed answer becomes an empty selection", () => {
    expect(askAnswers(payload, { answers: { q1: { selected: "Postgres", freeText: " " } } })).toEqual([
      { question: "Which database?", header: "Database", selected: [] },
      { question: "Which colors?", header: "Colors", selected: [] },
    ]);
    expect(askAnswers(payload, null)).toHaveLength(2);
  });

  test("describes the submission for the timeline", () => {
    const one = buildAskPayload(parsed([question()]));
    expect(describeAsk(askAnswers(one, { answers: { q1: { selected: [], freeText: "MySQL" } } }))).toEqual({
      title: "Answered Database: MySQL",
      detail: "- Which database? — MySQL",
    });
    const both = describeAsk(askAnswers(payload, { answers: { q1: { selected: ["SQLite"] } } }));
    expect(both.title).toBe("Answered 2 questions");
    expect(both.detail).toBe("- Which database? — SQLite\n- Which colors? — no answer");
  });

  test("the cancel message names the reason and tells the agent to ask in chat", () => {
    const message = askCancelledMessage("timeout");
    expect(message).toContain("reason: timeout");
    expect(message).toContain("Ask the question in chat");
  });
});
