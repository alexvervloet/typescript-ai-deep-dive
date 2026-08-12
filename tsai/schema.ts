/**
 * tsai/schema.ts: the boundary between "the model said so" and "my program
 * believes it."
 *
 * This is the one file to read if you read only one. The whole dive turns on a
 * fact that surprises people arriving from Python:
 *
 *     TypeScript's types do not exist at runtime.
 *
 * `tsc` checks your code and then throws every type away. What runs is
 * JavaScript. So this line:
 *
 *     const receipt = JSON.parse(reply) as Receipt;   // a lie you can compile
 *
 * checks nothing. Not one field. If the model returned `{"total": "twelve"}` you
 * now hold a `Receipt` whose `total` is a string, the compiler is happy, and the
 * failure surfaces three functions later as `NaN` in a number you are about to
 * write to a database. Example 04 does exactly that, on purpose, and prints the
 * corrupted total.
 *
 * The fix is not a better annotation. It is a **runtime check that also produces
 * the type**, which is what Zod does: you declare the schema once, Zod validates
 * the value at runtime, and TypeScript infers the static type from the same
 * declaration. One source of truth, enforced in both worlds. It is the same job
 * Pydantic does in the Python dives, and for the same reason.
 *
 * Everything below is a thin, honest wrapper around that idea.
 */

import { z } from "zod";

/** The result of parsing something a model said. Success or a readable reason. */
export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Models wrap JSON in Markdown code fences even when you tell them not to.
 * Strip them before parsing. This is a small piece of grubby reality that every
 * LLM codebase ends up owning.
 */
export function stripFences(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return fenced?.[1]?.trim() ?? trimmed;
}

/** Turn a Zod error into something a human can act on. */
export function explainZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

/**
 * Parse text a model produced into a validated value.
 *
 * Two things can go wrong and they are worth telling apart: the text was not
 * JSON at all (the model wrote prose), or it was JSON of the wrong shape (the
 * model invented a field, or sent a number as a string). Both come back as
 * `{ ok: false }` with a message that says which.
 *
 * Note the return type. This function never throws and never hands you an
 * unchecked value, so at the call site there is no way to *skip* the check: to
 * reach `.value` you have to look at `.ok` first, and the compiler enforces it.
 * That is a discriminated union doing real work.
 */
export function parseModelJson<T>(text: string, schema: z.ZodType<T>): ParseResult<T> {
  let raw: unknown;
  try {
    raw = JSON.parse(stripFences(text));
  } catch {
    const preview = text.trim().slice(0, 60);
    return { ok: false, error: `not JSON at all (starts with: ${JSON.stringify(preview)})` };
  }
  return parseUnknown(raw, schema);
}

/**
 * Validate an already-decoded value: the tool arguments off a `tool_use` block,
 * a webhook body, a row out of a cache. Anything that arrived as `unknown`.
 */
export function parseUnknown<T>(value: unknown, schema: z.ZodType<T>): ParseResult<T> {
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, error: explainZodError(result.error) };
}

/**
 * A Zod schema, converted to the JSON Schema a provider wants for tool
 * definitions and structured output.
 *
 * Zod 4 ships this conversion in the box (`z.toJSONSchema`); Zod 3 needed a
 * separate `zod-to-json-schema` package, which you will still see in older
 * codebases. We drop the `$schema` key because providers do not want it, and we
 * target draft-7, which is what both providers document.
 *
 * The payoff is that a tool's argument shape is declared exactly once. The same
 * schema object becomes the JSON Schema the model is shown *and* the validator
 * that checks what the model sends back. They cannot drift apart.
 */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  delete json["$schema"];
  return json;
}
