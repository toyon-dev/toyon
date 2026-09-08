import { describe, expect, test } from "bun:test";
import type { CreateElicitationRequest, ElicitationPropertySchema } from "@agentclientprotocol/sdk";
import { parseForm, toContent } from "./elicit.ts";

// The fixtures below are shaped exactly like `askUserQuestionsToCreateRequest` in
// @agentclientprotocol/claude-agent-acp: `question_<n>` selects, a `question_<n>_custom`
// companion carrying the un-namespaced marker, option previews under the Claude `_meta` key.

const form = (properties: Record<string, ElicitationPropertySchema>, message = "Which one?", required?: string[]) =>
  ({
    mode: "form",
    sessionId: "s1",
    toolCallId: "t1",
    message,
    requestedSchema: { type: "object", properties, ...(required ? { required } : {}) },
  }) as CreateElicitationRequest;

const select = (title: string, options: Array<[string, string?, string?]>, description?: string) =>
  ({
    type: "string",
    title,
    ...(description ? { description } : {}),
    oneOf: options.map(([label, desc, preview]) => ({
      const: label,
      title: label,
      ...(desc ? { description: desc } : {}),
      ...(preview ? { _meta: { "_claude/askUserQuestionOption": { preview } } } : {}),
    })),
  }) as ElicitationPropertySchema;

const multi = (title: string, labels: string[]) =>
  ({
    type: "array",
    title,
    items: { anyOf: labels.map((l) => ({ const: l, title: l })) },
  }) as ElicitationPropertySchema;

const custom = (questionId: string) =>
  ({
    type: "string",
    title: "Other",
    description: "Type your own answer instead of choosing an option above (optional).",
    _meta: { _askUserQuestionCustomAnswer: { questionId, isCustomAnswer: true } },
  }) as ElicitationPropertySchema;

describe("parseForm", () => {
  test("one question: the options carry value, label, description and preview", () => {
    const parsed = parseForm(
      form({
        question_0: select("Auth", [
          ["Session cookies", "simplest", "GET /login\n302"],
          ["JWT in header", "stateless"],
        ]),
        question_0_custom: custom("question_0"),
      }),
    );
    expect(parsed?.questions).toEqual([
      {
        id: "question_0",
        text: "",
        header: "Auth",
        options: [
          { value: "Session cookies", label: "Session cookies", description: "simplest", preview: "GET /login\n302" },
          { value: "JWT in header", label: "JWT in header", description: "stateless" },
        ],
        note: { label: "Other" },
      },
    ]);
    expect(parsed?.fields).toEqual([{ select: "question_0", note: "question_0_custom" }]);
  });

  test("the question text comes from the field description when the agent asked more than one", () => {
    const parsed = parseForm(
      form(
        {
          question_0: select("Auth", [["Cookies"], ["JWT"]], "Which auth approach?"),
          question_1: select("Store", [["Postgres"], ["SQLite"]], "Which datastore?"),
        },
        "Please answer the following questions.",
      ),
    );
    expect(parsed?.questions.map((q) => q.text)).toEqual(["Which auth approach?", "Which datastore?"]);
  });

  test("a note field is matched to its question and never becomes a question of its own", () => {
    // the companion deliberately sits before the question it answers
    const parsed = parseForm({
      ...form({
        question_0_custom: custom("question_0"),
        question_0: select("Auth", [["Cookies"], ["JWT"]]),
      }),
    });
    expect(parsed?.questions).toHaveLength(1);
    expect(parsed?.questions[0]?.note).toEqual({ label: "Other" });
  });

  test("a multi-select question is read from items.anyOf", () => {
    const parsed = parseForm(form({ question_0: multi("Targets", ["web", "ios", "android"]) }));
    expect(parsed?.questions[0]?.multi).toBe(true);
    expect(parsed?.questions[0]?.options.map((o) => o.value)).toEqual(["web", "ios", "android"]);
  });

  test("an untitled enum names its options with their own values", () => {
    const parsed = parseForm(
      form({ choice: { type: "string", enum: ["retry", "keep"] } as ElicitationPropertySchema }),
    );
    expect(parsed?.questions[0]?.options).toEqual([
      { value: "retry", label: "retry" },
      { value: "keep", label: "keep" },
    ]);
  });

  test("required is carried through", () => {
    const parsed = parseForm(form({ question_0: select("Auth", [["Cookies"], ["JWT"]]) }, "Which?", ["question_0"]));
    expect(parsed?.questions[0]?.required).toBe(true);
  });

  test("a form with a field of its own is not a card", () => {
    // an MCP server asking for a name, a port and a flag: a real form, and toyon has no form UI
    expect(parseForm(form({ name: { type: "string" } as ElicitationPropertySchema }))).toBeNull();
    expect(parseForm(form({ port: { type: "number" } as ElicitationPropertySchema }))).toBeNull();
    expect(parseForm(form({ ok: { type: "boolean" } as ElicitationPropertySchema }))).toBeNull();
    // one good select does not rescue a form that also carries a free-text field
    expect(
      parseForm(
        form({ question_0: select("Auth", [["Cookies"]]), name: { type: "string" } as ElicitationPropertySchema }),
      ),
    ).toBeNull();
  });

  test("a form with no properties at all is not a card", () => {
    expect(parseForm(form({}))).toBeNull();
  });
});

describe("toContent", () => {
  const parsed = () =>
    parseForm(
      form({
        question_0: select("Auth", [["Session cookies"], ["JWT in header"]]),
        question_0_custom: custom("question_0"),
      }),
    )!;

  test("a pick alone writes only the select field", () => {
    expect(toContent(parsed(), [{ selected: ["JWT in header"] }])).toEqual({ question_0: "JWT in header" });
  });

  test("a pick with a note writes both, with the label leading the note", () => {
    expect(
      toContent(parsed(), [{ selected: ["Session cookies"], note: "  only if refresh stays server-side  " }]),
    ).toEqual({
      question_0: "Session cookies",
      question_0_custom: "Session cookies: only if refresh stays server-side",
    });
  });

  test("a note with nothing picked is the whole answer", () => {
    expect(toContent(parsed(), [{ selected: [], note: "neither, use the edge worker" }])).toEqual({
      question_0_custom: "neither, use the edge worker",
    });
  });

  test("a value the agent never offered is dropped", () => {
    expect(toContent(parsed(), [{ selected: ["Something else"] }])).toEqual({});
  });

  test("a single-select takes only the first survivor", () => {
    expect(toContent(parsed(), [{ selected: ["JWT in header", "Session cookies"] }])).toEqual({
      question_0: "JWT in header",
    });
  });

  test("a multi-select writes an array", () => {
    const f = parseForm(form({ question_0: multi("Targets", ["web", "ios", "android"]) }))!;
    expect(toContent(f, [{ selected: ["web", "android"] }])).toEqual({ question_0: ["web", "android"] });
  });

  test("a question nobody answered writes nothing, which the agent reads as skipped", () => {
    const f = parseForm(
      form({
        question_0: select("Auth", [["Cookies"], ["JWT"]], "Which auth?"),
        question_1: select("Store", [["Postgres"], ["SQLite"]], "Which store?"),
      }),
    )!;
    expect(toContent(f, [{ selected: ["JWT"] }, { selected: [] }])).toEqual({ question_0: "JWT" });
  });

  test("a whitespace-only note is not a note", () => {
    expect(toContent(parsed(), [{ selected: ["JWT in header"], note: "   " }])).toEqual({
      question_0: "JWT in header",
    });
  });
});
