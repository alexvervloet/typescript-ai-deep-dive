/**
 * Example 04: parse what the model said, do not assume it (offline, no API call).
 *
 * Example 01 showed that the cast is a lie. This one turns that into the working
 * discipline, using five replies a model genuinely produces when you ask it for
 * a receipt as JSON. Nothing here is invented for the demo: fenced JSON, a
 * refusal in prose, a number sent as a string, and a hallucinated extra field are
 * the four ways this goes wrong in production, plus the one where it goes right.
 *
 * The frame worth stealing is "parse, don't validate": the checking function
 * does not return a boolean, it returns the typed value or a reason. So there is
 * no way to write the bug where you validate and then use the original unchecked
 * variable anyway, which is the classic Pydantic-shaped mistake ported to a
 * language that will not stop you.
 *
 *     npx tsx examples/04_parse_dont_assume.ts
 */

import { z } from "zod";
import { bold, cyan, dim, green, heading, red, table, yellow } from "../tsai/fmt.ts";
import { parseModelJson, stripFences } from "../tsai/schema.ts";

/** What we asked the model for. One declaration, two jobs: it is the static type
 * (via z.infer) and the runtime check (via safeParse). They cannot drift. */
const Receipt = z.object({
  merchant: z.string(),
  total: z.number(),
  currency: z.string().length(3),
});

type Receipt = z.infer<typeof Receipt>;

/** Five replies. Every one of these is a thing a real model has done. */
const REPLIES: Array<[label: string, text: string]> = [
  ["clean JSON", '{"merchant":"Kaffee & Co","total":12.4,"currency":"EUR"}'],
  ["wrapped in fences", '```json\n{"merchant":"Kaffee & Co","total":12.4,"currency":"EUR"}\n```'],
  ["number as a string", '{"merchant":"Kaffee & Co","total":"12.40","currency":"EUR"}'],
  [
    "invented a field",
    '{"merchant":"Kaffee & Co","total":12.4,"currency":"EUR","confidence":0.93}',
  ],
  ["refused, in prose", "I'm sorry, I can't read the total on this receipt."],
];

// ---------------------------------------------------------------------------

console.log(heading("1. What the two approaches do with each reply"));

const rows: string[][] = [];
for (const [label, text] of REPLIES) {
  // The optimistic version, which is what most code does on the first pass.
  let castResult: string;
  try {
    const receipt = JSON.parse(stripFences(text)) as Receipt;
    // Looks fine. Now use it the way real code would.
    castResult = `${green("accepted")}, total+1 = ${JSON.stringify(receipt.total + 1)}`;
  } catch (error) {
    castResult = `${red("threw")} ${(error as Error).name}`;
  }

  const parsed = parseModelJson(text, Receipt);
  const parseResult = parsed.ok
    ? `${green("accepted")}, total+1 = ${JSON.stringify(parsed.value.total + 1)}`
    : `${red("rejected")}: ${parsed.error}`;

  rows.push([label, castResult, parseResult]);
}

console.log(
  "\n" +
    table(
      [{ header: "model reply" }, { header: "JSON.parse(...) as Receipt" }, { header: "parseModelJson(..., Receipt)" }],
      rows,
    ),
);

console.log(`
  Row by row:

  ${bold("clean JSON")} and ${bold("wrapped in fences")} both work, once you strip fences. Every
  LLM codebase ends up owning that four-line regex; models add fences no matter
  how firmly the prompt says not to.

  ${bold("number as a string")} is the one that matters. The cast accepts it and
  computes ${yellow('"12.401"')}, which is example 01's coercion bug arriving in
  production. The parse rejects it and tells you which field and why.

  ${bold("invented a field")} is accepted by both, and that is worth sitting with.
  Zod strips unknown keys by default, so \`confidence\` is silently dropped. If you
  would rather hear about it, use ${cyan(".strict()")}, which turns an unexpected key into
  an error. Neither choice is wrong; the mistake is not knowing which one you
  picked. Section 3 below shows the difference.

  ${bold("refused, in prose")} is the row people forget to handle. The cast throws a
  SyntaxError from deep inside JSON.parse, with a message about position 0. The
  parse returns a description you can log, retry on, or show a user.`);

// ---------------------------------------------------------------------------

console.log(heading("2. Why the return type does the teaching"));

const parsed = parseModelJson(REPLIES[2]![1], Receipt);

console.log(`
    ${dim("const parsed = parseModelJson(reply, Receipt);")}
    ${dim("parsed.value.total")}     ${red("compile error: property 'value' does not exist on type ...")}

  ${cyan("ParseResult<T>")} is ${cyan("{ ok: true, value: T } | { ok: false, error: string }")}, so
  the compiler will not let you reach ${cyan(".value")} until you have narrowed on ${cyan(".ok")}.
  You cannot forget the check, because forgetting it does not compile.

  That is the difference between a validator and a parser. A validator returns a
  boolean and leaves the unchecked value sitting there, still usable, still the
  wrong type. A parser hands back a new value that is the right type by
  construction, and the old one is not what you got.

  Right now parsed.ok is ${parsed.ok ? green("true") : red("false")}${parsed.ok ? "" : `, so the only branch available says: ${parsed.error}`}.`);

// ---------------------------------------------------------------------------

console.log(heading("3. Two dials, and the honest cost of each"));

const Strict = Receipt.strict();
const Coercing = z.object({
  merchant: z.string(),
  total: z.coerce.number(),
  currency: z.string().length(3),
});

const extraField = REPLIES[3]![1];
const stringNumber = REPLIES[2]![1];
const notANumber = '{"merchant":"Kaffee & Co","total":"about twelve","currency":"EUR"}';

const dialRows = [
  [
    "default",
    "invented a field",
    Receipt.safeParse(JSON.parse(extraField)).success
      ? `${green("accepted")}, extra key dropped`
      : red("rejected"),
  ],
  [
    ".strict()",
    "invented a field",
    Strict.safeParse(JSON.parse(extraField)).success
      ? green("accepted")
      : `${red("rejected")}: unrecognized key`,
  ],
  [
    "default",
    "number as a string",
    Receipt.safeParse(JSON.parse(stringNumber)).success ? green("accepted") : red("rejected"),
  ],
  [
    "z.coerce.number()",
    "number as a string",
    (() => {
      const r = Coercing.safeParse(JSON.parse(stringNumber));
      return r.success ? `${green("accepted")}, total = ${r.data.total}` : red("rejected");
    })(),
  ],
  [
    "z.coerce.number()",
    '"about twelve"',
    (() => {
      const r = Coercing.safeParse(JSON.parse(notANumber));
      return r.success ? `${green("accepted")}, total = ${r.data.total}` : `${red("rejected")}: not a number`;
    })(),
  ],
];

console.log("\n" + table([{ header: "schema" }, { header: "reply" }, { header: "result" }], dialRows));

console.log(`
  ${bold("Coercion is a real tool with a real cost.")} ${cyan("z.coerce.number()")} turns
  "12.40" into 12.4 and keeps your pipeline running, and it still rejects
  "about twelve", so it is not a blanket surrender. What it costs you is the
  signal: the day your prompt starts producing strings for every number, a
  coercing schema will never tell you. A strict schema fails loudly and you go
  fix the prompt.

  The rule of thumb this repo lands on: ${bold("coerce at the edges you do not")}
  ${bold("control, stay strict on the ones you do.")} A model's output is an edge you
  do not control, so coerce only the fields where the ambiguity is genuinely
  harmless, and keep the eval that would notice the drift.`);

console.log(`
${heading("Where this goes next")}
  A rejection is not the end of the turn. The two moves from here are asking the
  provider to guarantee the shape in the first place (example 05) and feeding the
  error message back to the model as a repair prompt, which is what Instructor
  does in the Python dives. Validation is what makes both of them possible: you
  cannot retry an error you never detected.`);
