// ACP form elicitations ↔ ask cards. This is the only file in toyon that knows JSON Schema
// exists: `shared` and the shell see questions and options.
//
// An agent's AskUserQuestion tool reaches us as `elicitation/create` in form mode, one
// `question_<n>` select per question plus an optional `question_<n>_custom` free-text companion.
// Only forms made entirely of selects (and their companions) can be drawn as a card; anything
// else is a real form, and the caller declines it.

import {
  type CreateElicitationRequest,
  CreateElicitationRequest as CreateElicitationRequestGuards,
  type ElicitationContentValue,
  type ElicitationPropertySchema,
  type EnumOption,
  MultiSelectItems,
  ElicitationPropertySchema as PropertyGuards,
} from "@agentclientprotocol/sdk";
import type { AskAnswer, AskOption, AskQuestion } from "@toyon/shared";

/** the `_meta` marker a bridged AskUserQuestion puts on a question's free-text field. Upstream
 * leaves it un-namespaced on purpose so every bridge can use the same one, which is why matching
 * on it rather than on `_claude/...` keeps this agent-agnostic. */
const CUSTOM_ANSWER_META = "_askUserQuestionCustomAnswer";
/** where the Claude bridge parks an option's longer sample, the one field EnumOption has no slot for */
const OPTION_PREVIEW_META = "_claude/askUserQuestionOption";

export interface ParsedForm {
  questions: AskQuestion[];
  /** per question, in the same order: the schema keys its answer is written back into */
  fields: Array<{ select: string; note?: string }>;
}

/** a property schema's custom variant is an open record, so every field is read defensively */
function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

function meta(value: unknown, key: string): unknown {
  return field(field(value, "_meta"), key);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** the question a free-text field answers, when the field is one */
function customAnswerFor(prop: ElicitationPropertySchema): string | null {
  return text(field(meta(prop, CUSTOM_ANSWER_META), "questionId")) ?? null;
}

function optionsOf(titled: EnumOption[]): AskOption[] {
  return titled.map((o) => {
    const preview = (meta(o, OPTION_PREVIEW_META) as { preview?: unknown } | undefined)?.preview;
    return {
      value: o.const,
      label: o.title,
      ...(o.description ? { description: o.description } : {}),
      ...(typeof preview === "string" ? { preview } : {}),
    };
  });
}

/** an untitled enum names its options with the values themselves */
function plainOptions(values: string[]): AskOption[] {
  return values.map((v) => ({ value: v, label: v }));
}

/** the choices a property offers, or null when it is not a select at all */
function selectOf(prop: ElicitationPropertySchema): { options: AskOption[]; multi: boolean } | null {
  if (PropertyGuards.isString(prop)) {
    if (prop.oneOf?.length) return { options: optionsOf(prop.oneOf), multi: false };
    if (prop.enum?.length) return { options: plainOptions(prop.enum), multi: false };
    return null;
  }
  if (PropertyGuards.isArray(prop)) {
    const items = prop.items;
    if (MultiSelectItems.isTitled(items) && items.anyOf.length) {
      return { options: optionsOf(items.anyOf), multi: true };
    }
    if (MultiSelectItems.isString(items) && items.enum.length) {
      return { options: plainOptions(items.enum), multi: true };
    }
    return null;
  }
  return null;
}

/** Read a form elicitation as questions, or null when toyon cannot draw it: a form carrying a
 * field of its own (free text, a number, a date) is a real form and belongs to a form UI we do
 * not have. */
export function parseForm(req: CreateElicitationRequest): ParsedForm | null {
  if (!CreateElicitationRequestGuards.isForm(req)) return null;
  const props = req.requestedSchema.properties;
  if (!props) return null;
  const entries = Object.entries(props);
  const required = new Set(req.requestedSchema.required ?? []);
  // the companions first, so a note field may sit on either side of the question it answers
  const notes = new Map<string, { key: string; label: string }>();
  for (const [key, prop] of entries) {
    const owner = customAnswerFor(prop);
    if (owner) notes.set(owner, { key, label: text(field(prop, "title")) ?? "Other" });
  }
  const questions: AskQuestion[] = [];
  const fields: ParsedForm["fields"] = [];
  for (const [key, prop] of entries) {
    if (customAnswerFor(prop)) continue;
    const select = selectOf(prop);
    if (!select) return null;
    const note = notes.get(key);
    const header = text(field(prop, "title"));
    questions.push({
      id: key,
      // the lead message carries the question when there is only one, so an empty text is
      // normal rather than missing; the card falls back to the message
      text: text(field(prop, "description")) ?? "",
      ...(header ? { header } : {}),
      options: select.options,
      ...(select.multi ? { multi: true } : {}),
      ...(note ? { note: { label: note.label } } : {}),
      ...(required.has(key) ? { required: true } : {}),
    });
    fields.push({ select: key, ...(note ? { note: note.key } : {}) });
  }
  return questions.length > 0 ? { questions, fields } : null;
}

/** the `content` object the agent expects back, keyed by the fields its own form named */
export function toContent(form: ParsedForm, answers: AskAnswer[]): Record<string, ElicitationContentValue> {
  const out: Record<string, ElicitationContentValue> = {};
  form.questions.forEach((q, i) => {
    const answer = answers[i];
    const field = form.fields[i];
    if (!answer || !field) return;
    // never hand the agent a value it did not offer: the card may be stale, and the answer
    // arrives from a browser
    const known = new Set(q.options.map((o) => o.value));
    const picked = answer.selected.filter((v) => known.has(v));
    const chosen = q.multi ? picked : picked.slice(0, 1);
    if (chosen.length > 0) out[field.select] = q.multi ? chosen : chosen[0]!;
    const note = answer.note?.trim();
    if (!note || !field.note) return;
    // the note rides with the pick instead of replacing it. The wire has one free-text slot per
    // question and the bridge lets it win over the selection, so writing the label into it is the
    // only way the agent reads both the choice and the caveat.
    const labels = chosen.map((v) => q.options.find((o) => o.value === v)?.label ?? v);
    out[field.note] = labels.length > 0 ? `${labels.join(", ")}: ${note}` : note;
  });
  return out;
}
