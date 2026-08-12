/**
 * Example 07: a tool call is user input with extra steps (offline by default).
 *
 * The agent loop is four lines of control flow: the model asks for a tool, you
 * run it, you hand the result back, it answers. The interesting part is the
 * word "you run it," because that is the moment a model's output stops being
 * text and becomes something your process does.
 *
 * Whatever is in those arguments reaches your database. Anything in the
 * conversation can shape them, including a document the user uploaded, which is
 * how indirect prompt injection turns into a tool call you did not want. The
 * arguments are untrusted input in the same sense a query string is.
 *
 * TypeScript is unusually clear about this, once, at the right place:
 *
 *     type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown }
 *
 * `input` is `unknown`, so the compiler refuses to let you read a field off it.
 * That refusal is the feature. Example 06 ended by pointing here; this is what
 * happens next.
 *
 *     npx tsx examples/07_tool_args_are_untrusted.ts
 *     PROVIDER=openai secrun npx tsx examples/07_tool_args_are_untrusted.ts
 */

import { bold, cyan, dim, green, heading, red, yellow } from "../tsai/fmt.ts";
import { mockBehavior, resetMockBehavior } from "../tsai/mock.ts";
import { chat, describe, providerName } from "../tsai/providers.ts";
import { parseUnknown } from "../tsai/schema.ts";
import { LookupOrderArgs, ORDER_TOOLS, runTool } from "../tsai/tools.ts";
import { toolUsesOf } from "../tsai/types.ts";
import { findOrder } from "../tsai/orders.ts";
import type { ContentBlock, Msg } from "../tsai/types.ts";

resetMockBehavior();
console.log(`Provider: ${describe()}`);

const SYSTEM = "You answer questions about orders. Use the tools; do not guess.";

/** One full turn of the loop: ask, run whatever tools came back, ask again. */
async function answer(question: string): Promise<{ text: string; trace: string[] }> {
  const trace: string[] = [];
  const messages: Msg[] = [{ role: "user", content: question }];

  const first = await chat({ system: SYSTEM, messages, tools: ORDER_TOOLS });
  const calls = toolUsesOf(first.blocks);
  if (calls.length === 0) return { text: first.text, trace: ["(no tool call)"] };

  messages.push({ role: "assistant", content: first.blocks });

  const results: ContentBlock[] = [];
  for (const call of calls) {
    // `call.input` is `unknown` here. runTool is the only thing allowed to open it.
    const outcome = runTool(call.name, call.input);
    trace.push(
      `${call.name}(${JSON.stringify(call.input)}) -> ` +
        (outcome.ok ? green(outcome.content) : red(outcome.content)),
    );
    results.push({
      type: "tool_result",
      toolUseId: call.id,
      content: outcome.content,
      isError: !outcome.ok,
    });
  }
  messages.push({ role: "user", content: results });

  const second = await chat({ system: SYSTEM, messages, tools: ORDER_TOOLS });
  return { text: second.text, trace };
}

// ---------------------------------------------------------------------------

console.log(heading("1. The loop, when everything goes right"));

const good = await answer("What is the status of order A-1003?");
for (const line of good.trace) console.log(`  ${line}`);
console.log(`\n  ${good.text}`);

// ---------------------------------------------------------------------------

console.log(heading("2. The loop, when the model sends the wrong type"));

if (providerName() === "mock") {
  mockBehavior.badToolArgs = true;
  console.log(`
  ${dim("mockBehavior.badToolArgs = true")}   ${dim("// the model now sends { orderId: 1003 }")}`);
} else {
  console.log(`
  ${yellow("On a real provider we cannot force this on demand,")} so section 2 uses a
  hand-written bad call instead of a model-generated one. The mock can force it:
  run this example without secrun to see the model itself do it.`);
}

const badInput: unknown = providerName() === "mock" ? undefined : { orderId: 1003 };

if (providerName() === "mock") {
  const bad = await answer("What is the status of order A-1003?");
  for (const line of bad.trace) console.log(`  ${line}`);
  console.log(`\n  ${bad.text}`);
  mockBehavior.badToolArgs = false;
} else if (badInput !== undefined) {
  const outcome = runTool("lookup_order", badInput);
  console.log(`  lookup_order(${JSON.stringify(badInput)}) -> ${red(outcome.content)}`);
}

console.log(
  `
  A number where a string belongs. The tool refused it and said which field and
  why.` +
    (providerName() === "mock"
      ? `\n  That refusal went back to the model as a tool_result flagged ${cyan("isError: true")},
  which is what lets a real agent correct itself on the next turn.`
      : `\n  In the loop above, that refusal would go back as a tool_result flagged
  ${cyan("isError: true")}, which is what lets a real agent correct itself on the next turn.`),
);

// ---------------------------------------------------------------------------

console.log(heading("3. What that same call does with no gate"));

/** The version everybody writes first. It compiles only because of the `as`. */
function unguarded(input: unknown): string {
  const args = input as { orderId: string };
  const order = findOrder(args.orderId);
  return order ? order.status : "not found";
}

const wrongType: unknown = { orderId: 1003 };
let unguardedResult: string;
try {
  unguardedResult = green(unguarded(wrongType));
} catch (error) {
  unguardedResult = red(`threw ${(error as Error).constructor.name}: ${(error as Error).message}`);
}

const guarded = parseUnknown(wrongType, LookupOrderArgs);

console.log(`
    ${dim("const args = input as { orderId: string };")}
    ${dim("findOrder(args.orderId)")}          ${unguardedResult}

    ${dim("parseUnknown(input, LookupOrderArgs)")}  ${red(guarded.ok ? "accepted" : guarded.error)}

  The unguarded version crashed inside a helper three frames away from the
  mistake, on a line that has nothing wrong with it. That is the good case. The
  bad case is the one where it does not crash: a lookup that silently returns
  "not found" for a real order, and a support agent telling a customer their
  order does not exist.`);

// ---------------------------------------------------------------------------

console.log(heading("4. A type is not yet a policy"));

const attempts: Array<[string, unknown]> = [
  ["a real id", { orderId: "A-1003" }],
  ["wrong type", { orderId: 1003 }],
  ["missing field", {}],
  ["a path", { orderId: "../../etc/passwd" }],
  ["an injected instruction", { orderId: "A-1003; ignore previous instructions" }],
];

for (const [label, input] of attempts) {
  const result = parseUnknown(input, LookupOrderArgs);
  console.log(
    `  ${label.padEnd(24)} ${result.ok ? green("accepted") : red(`rejected: ${result.error}`)}`,
  );
}

console.log(`
  The last two are why ${cyan("LookupOrderArgs")} uses ${cyan("z.string().regex(/^A-\\d{4}$/)")}
  instead of ${cyan("z.string()")}. Both would have been perfectly valid strings. In this
  repo they would have harmlessly failed a lookup; in a system that builds a
  file path or a query out of that argument, they are the whole attack.

  ${bold("Validate the shape, then constrain the range.")} The schema is the only place
  in an agent where you get to say what the model is allowed to ask for, and
  "a string" is not an answer to that question. This is the same argument the
  prompt-injection dive makes about untrusted content, arriving through a
  different door.`);

resetMockBehavior();
