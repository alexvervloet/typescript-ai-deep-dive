/**
 * Example 06: content blocks, where TypeScript is better than Python (offline).
 *
 * Most of this dive is about TypeScript being less help than you expected. This
 * example is the other side of the ledger, and the difference is not marginal.
 *
 * A model's reply is a list of typed blocks: some text, maybe a request to call
 * a tool. In Python you walk that list and reach into each item with `isinstance`
 * checks or dictionary keys, and nothing verifies you got the pairing right. A
 * typo in a key, a field that only exists on one variant, a branch you forgot
 * when the provider added a block type: all runtime problems, all found in
 * production, all found on the unlucky request rather than the common one.
 *
 * A discriminated union turns every one of those into a compile error. This
 * example does not claim that. It runs the compiler on files that get it wrong
 * and prints what comes out.
 *
 *     npx tsx examples/06_blocks_and_unions.ts
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { bold, cyan, dim, green, heading, red, yellow } from "../tsai/fmt.ts";
import { fromRoot } from "../tsai/env.ts";
import { chat } from "../tsai/providers.ts";
import type { ContentBlock } from "../tsai/types.ts";

const run = promisify(execFile);

// ---------------------------------------------------------------------------

console.log(heading("1. A reply is a list of typed blocks"));

const reply = await chat({
  system: "Use the tools when a question is about a specific order.",
  messages: [{ role: "user", content: "What is the status of order A-1003?" }],
  tools: [
    {
      name: "lookup_order",
      description: "Look up one order by its id.",
      parameters: z.object({ orderId: z.string() }),
    },
  ],
});

console.log(`\n${dim(JSON.stringify(reply.blocks, null, 2))}`);
console.log(`\n  stopReason: ${cyan(reply.stopReason)}`);

// ---------------------------------------------------------------------------

console.log(heading("2. Narrowing, and the never trick"));

/**
 * One function, every block type, checked.
 *
 * Inside each `case`, `block` is narrowed to that variant: the compiler knows
 * `text` exists in the first branch and `name` exists in the third. The default
 * branch is where the safety lives, and it is worth understanding rather than
 * copying:
 *
 * TypeScript narrows `block` by elimination. If the cases above cover the whole
 * union, nothing is left, and the type of `block` here is `never`. Assigning it
 * to a `never` variable is therefore legal. The day someone adds a variant to
 * ContentBlock, that assignment stops being legal, and the error names the
 * variant you did not handle.
 */
function summarize(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return `text (${block.text.length} chars)`;
    case "image":
      return `image (${block.mediaType})`;
    case "tool_use":
      return `tool_use -> ${block.name}`;
    case "tool_result":
      return `tool_result for ${block.toolUseId}`;
    default: {
      const unhandled: never = block;
      return `unhandled: ${JSON.stringify(unhandled)}`;
    }
  }
}

// The real reply above, plus one of each remaining variant so you can see every
// branch fire. All four are the same union; `summarize` needs no overloads.
const everyKind: ContentBlock[] = [
  ...reply.blocks,
  { type: "text", text: "Order A-1003 is still pending." },
  { type: "image", mediaType: "image/png", dataBase64: "iVBORw0KGgo=" },
  { type: "tool_result", toolUseId: "call_1", content: "A-1003: pending" },
];

for (const block of everyKind) console.log(`  ${green(summarize(block))}`);

console.log(`
  ${bold("This is a static guarantee, not a convention.")} There is no test to write
  and no review checklist item. Handling every case is the condition for the
  program existing.`);

// ---------------------------------------------------------------------------

console.log(heading("3. What the compiler says when you get it wrong"));

console.log(`
  The repo has a ${cyan("broken/")} directory whose files are meant to fail. Running
  the real compiler on them now:

    ${dim("npx tsc -p broken")}
`);

let compilerOutput = "";
try {
  const result = await run(process.execPath, [
    fromRoot("node_modules", "typescript", "bin", "tsc"),
    "-p",
    fromRoot("broken"),
  ]);
  compilerOutput = result.stdout || "(no errors, which is itself a bug in this example)";
} catch (error) {
  // tsc exits non-zero when it finds errors, and writes them to stdout.
  compilerOutput = (error as { stdout?: string }).stdout ?? String(error);
}

for (const line of compilerOutput.trimEnd().split("\n")) {
  console.log(`    ${red(line)}`);
}

console.log(`
  Read the first one again:

    ${red("missing_case.ts: Type 'ToolResultBlock' is not assignable to type 'never'.")}

  The compiler did not say "you missed a case." It said ${bold("which")} case, by name,
  because the leftover type after narrowing ${bold("is")} the case you forgot. That error
  appears the moment a new block type joins the union, in every switch that does
  not handle it, across the whole codebase, without anyone remembering to look.

  The other two are the everyday version: reading ${cyan(".text")} off a block before
  checking its type, and reading ${cyan(".text")} off a block already narrowed to
  ${cyan("tool_use")}, which has no such field.`);

// ---------------------------------------------------------------------------

console.log(heading("4. The honest limit"));

console.log(`
  This chapter's win is real and it is bounded. What the compiler checked above
  is that ${bold("your code")} agrees with ${bold("your declared union")}. It did not check that
  the provider's JSON agrees with either one.

  The SDKs ship their own types for their own responses, and those types are a
  description of the API, written by hand, shipped in a package, and updated on
  the SDK's release schedule. They are a claim. Nothing validates the bytes.

  So the two halves of this repo compose:

    ${yellow("shape of the reply")}    handled by the union. Checked at compile time.
    ${yellow("contents of the reply")} handled by Zod. Checked at runtime.

  Notice which side ${cyan("ToolUseBlock.input")} sits on: it is typed ${cyan("unknown")}, precisely
  because the compiler has nothing useful to say about it. Example 07 picks it up
  from there.`);
