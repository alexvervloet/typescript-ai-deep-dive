/**
 * Example 05: making the provider guarantee the shape, and what that does not buy.
 *
 * Example 04 caught bad JSON after the fact. Both providers will also enforce a
 * shape up front, and in TypeScript the ergonomics are genuinely good: one Zod
 * schema becomes the JSON Schema the provider is given AND the validator you run
 * on the reply. In Zod 4 the conversion is built in (`z.toJSONSchema`), so there
 * is no second declaration to keep in sync.
 *
 * The two providers get there differently, which is worth knowing:
 *
 *   OpenAI     `response_format: { type: "json_schema", strict: true, ... }`.
 *              A first-class feature. Invalid JSON becomes impossible.
 *   Anthropic  no equivalent field. The documented route is to define one tool
 *              whose input schema is your shape, then force the model to call
 *              it. Structured output turns out to be tool use wearing a hat.
 *
 * Both are in tsai/providers.ts. And then the part this example exists for:
 *
 *     A guaranteed shape is not a guaranteed answer.
 *
 * A schema makes the model fill every required field. It does not make the
 * contents true. Section 3 asks for a field the source text does not contain and
 * watches a perfectly valid, entirely invented value come back.
 *
 * NEEDS A REAL MODEL. This is the one example in the repo the mock cannot teach:
 * schema enforcement is a provider feature, and a keyword matcher inventing a
 * plausible VAT number would be theatre, not evidence. On PROVIDER=mock it
 * prints the request shapes and stops.
 *
 *     PROVIDER=openai secrun npx tsx examples/05_structured_output.ts
 *     PROVIDER=claude secrun npx tsx examples/05_structured_output.ts
 */

import { z } from "zod";
import { bold, cyan, dim, green, heading, red, yellow } from "../tsai/fmt.ts";
import { chat, describe, providerName } from "../tsai/providers.ts";
import { parseModelJson, toJsonSchema } from "../tsai/schema.ts";

const RECEIPT_TEXT = `
Kaffee & Co, Hauptstrasse 12, Berlin
2026-06-21  14:32
1x Flat white          3.80
1x Almond croissant    3.20
--------------------------
TOTAL                  7.00
Paid by card
`.trim();

const Receipt = z.object({
  merchant: z.string(),
  date: z.string(),
  total: z.number(),
});

/** The same shape, plus a field the receipt above simply does not have. */
const ReceiptWithVat = Receipt.extend({
  vatNumber: z.string(),
});

/** The honest version of the same request: the model is allowed to say "absent". */
const ReceiptWithOptionalVat = Receipt.extend({
  vatNumber: z.string().nullable(),
});

console.log(`Provider: ${describe()}`);

console.log(heading("The one schema, and the two things it becomes"));
console.log(`
    ${dim("const Receipt = z.object({ merchant: z.string(), date: z.string(), total: z.number() });")}

  As a static type:   ${cyan("type Receipt = z.infer<typeof Receipt>")}
  As a runtime check: ${cyan("Receipt.safeParse(value)")}
  As a provider contract:

${dim(JSON.stringify(toJsonSchema(Receipt), null, 2).split("\n").map((l) => "    " + l).join("\n"))}

  In the Python dives this is Pydantic's job and it works the same way. The
  difference is that here the static type is the ${bold("only")} thing you would have
  had without it, and the static type does nothing at runtime. Zod is not a
  convenience in TypeScript the way Pydantic is a convenience in Python. It is
  the part that actually checks.`);

if (providerName() === "mock") {
  console.log(`
${heading("Stopping here")}
  ${yellow("PROVIDER=mock cannot demonstrate this example.")} Schema enforcement happens
  inside the provider, and the offline mock would have to invent a VAT number to
  play along, which would prove nothing about how a real model behaves.

  Run it for real:

    ${cyan("PROVIDER=openai secrun npx tsx examples/05_structured_output.ts")}
    ${cyan("PROVIDER=claude secrun npx tsx examples/05_structured_output.ts")}

  Sections 1 to 4 are one API call each, on the cheap default models.`);
  process.exit(0);
}

// ---------------------------------------------------------------------------

console.log(heading("1. Asking nicely"));

const asked = await chat({
  system:
    "Extract the receipt as JSON with keys merchant, date, total. " +
    "Return ONLY JSON, no prose and no code fences.",
  messages: [{ role: "user", content: RECEIPT_TEXT }],
});
const askedParsed = parseModelJson(asked.text, Receipt);
const wasFenced = asked.text.trim().startsWith("```");
console.log(`
  raw reply:  ${dim(JSON.stringify(asked.text.slice(0, 120)))}
  validated:  ${askedParsed.ok ? green("ok") : red(askedParsed.error)}`);

console.log(`
  ${bold("What went wrong here is provider-dependent, which is the point.")} Across the
  two default models this repo ships, one returns the total as a string and fails
  validation, and the other obeys the shape but wraps it in the code fences the
  prompt explicitly forbade. On this run: ${
    askedParsed.ok
      ? green(`the shape was right${wasFenced ? ", but it arrived inside code fences" : ""}`)
      : red(`validation failed (${askedParsed.error})`)
  }.
  "It worked when I tried it" is not evidence that prompt-only JSON is reliable.
  It is evidence about one model on one day.`);

// ---------------------------------------------------------------------------

console.log(heading("2. Making the provider enforce it"));

const enforced = await chat({
  system: "Extract the receipt.",
  messages: [{ role: "user", content: RECEIPT_TEXT }],
  responseSchema: Receipt,
  responseSchemaName: "receipt",
});
const enforcedParsed = parseModelJson(enforced.text, Receipt);
console.log(`
  raw reply:  ${dim(JSON.stringify(enforced.text.replace(/\s+/g, " ").slice(0, 120)))}
  validated:  ${enforcedParsed.ok ? green("ok") : red(enforcedParsed.error)}`);

console.log(`
  Note that we still validated. The provider promises the JSON matches the
  schema it was given, which is a promise about transport, not about your
  program: the schema could be stale, the SDK could be a version behind, a
  future model could regress. Keeping the parse costs microseconds and turns a
  class of production incident into a log line.`);

// ---------------------------------------------------------------------------

console.log(heading("3. The part a schema cannot do"));

const invented = await chat({
  system: "Extract the receipt.",
  messages: [{ role: "user", content: RECEIPT_TEXT }],
  responseSchema: ReceiptWithVat,
  responseSchemaName: "receipt_with_vat",
});
const inventedParsed = parseModelJson(invented.text, ReceiptWithVat);

console.log(`
  We added ${cyan("vatNumber: z.string()")} to the schema. Read the receipt again: it has
  no VAT number. The model must return one anyway, because the schema says the
  field is required.

  raw reply:  ${dim(JSON.stringify(invented.text.replace(/\s+/g, " ").slice(0, 160)))}
  validated:  ${inventedParsed.ok ? green("ok, every field present and correctly typed") : red(inventedParsed.error)}`);

/** What kind of non-answer did we get? The example has to report what actually
 * came back, because the three cases teach different things and we cannot know
 * in advance which one this model, today, will pick. */
function classify(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") return "an empty string";
  if (/^[<[(]?\s*(unknown|n\/?a|none|null|not\s*(provided|found|available|specified))\s*[>\])]?$/i.test(trimmed)) {
    return "a made-up sentinel meaning \"I do not know\"";
  }
  return "a concrete, plausible value that appears nowhere in the source text";
}

if (inventedParsed.ok) {
  const value = inventedParsed.value.vatNumber;
  console.log(`  vatNumber:  ${yellow(JSON.stringify(value))}   ${red(`<- ${classify(value)}`)}`);
}

console.log(`
  ${bold("Whatever came back above, it passed every check in this repo.")} Zod is happy,
  the provider is happy, the type is right, and the value is not a VAT number.

  Measured across the two models this repo defaults to, neither hallucinated a
  realistic VAT number. ${cyan("gpt-5.4-nano")} returned ${yellow('""')}; ${cyan("claude-haiku-4-5")} returned
  ${yellow('"<UNKNOWN>"')}. That is better behavior than inventing one, and it is still a
  problem, for a reason that is easy to miss:

    ${bold("Each model invents its own private encoding for \"absent\", and your")}
    ${bold("schema said those were valid strings.")}

  Nothing documents the sentinel. Nothing stops it changing between model
  versions. A field typed ${cyan("z.string()")} cannot distinguish a real VAT number from
  ${yellow('"<UNKNOWN>"')}, so the string "<UNKNOWN>" is now in your database, in a column
  your finance export reads. The schema did not prevent the bad value; it only
  guaranteed the bad value would be a string.`);

// ---------------------------------------------------------------------------

console.log(heading("4. The fix is in the schema, not the prompt"));

const nullable = await chat({
  system: "Extract the receipt. Use null for any field the receipt does not contain.",
  messages: [{ role: "user", content: RECEIPT_TEXT }],
  responseSchema: ReceiptWithOptionalVat,
  responseSchemaName: "receipt_optional_vat",
});
const nullableParsed = parseModelJson(nullable.text, ReceiptWithOptionalVat);

console.log(`
  Same request, one change: ${cyan("vatNumber: z.string().nullable()")}, plus a system
  prompt that says null means absent. Now "I did not find it" is a legal answer.

  raw reply:  ${dim(JSON.stringify(nullable.text.replace(/\s+/g, " ").slice(0, 160)))}`);
if (nullableParsed.ok) {
  const value = nullableParsed.value.vatNumber;
  console.log(
    `  vatNumber:  ${value === null ? green("null") : yellow(JSON.stringify(value))}` +
      `   ${value === null ? green("<- the model was able to tell the truth") : red("<- still invented, see below")}`,
  );
}

console.log(`
${heading("What to take from this")}
  ${bold("Every required field is a question the model is forbidden to duck.")} That is
  the design lesson, and it is not a TypeScript lesson at all: it applies
  identically to Pydantic. A required field with no answer in the source forces
  the model to put ${bold("something")} there, and what it picks is undocumented.

  So design schemas that permit ignorance. Nullable fields for anything that may
  legitimately be absent, and an enum with an "unknown" member instead of a
  forced choice between three categories. The value of ${cyan("null")} over ${yellow('"<UNKNOWN>"')} is
  not tidiness: it is that ${cyan("null")} is in the contract, so your code can branch on
  it and your types can force you to.

  What TypeScript adds is only that the check has to be there at all. In Python
  you could skip Pydantic and still get a dict you could read. Here, skipping the
  parse leaves you holding an ${cyan("unknown")}, and the compiler will not let you
  pretend otherwise unless you lie to it with ${cyan("as")}.`);
