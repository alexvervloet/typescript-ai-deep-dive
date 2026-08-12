/**
 * The capstone: a typed agent you can actually use.
 *
 *     npx tsx hands_on/ask.ts "What is the status of order A-1003?"
 *     npx tsx hands_on/ask.ts "Which orders are still pending?" --trace
 *     npx tsx hands_on/ask.ts "How much has Rivera spent?" --json
 *     npx tsx hands_on/ask.ts "List the shipped orders" --timeout 5000
 *
 *     PROVIDER=openai secrun npx tsx hands_on/ask.ts "Is A-1007 shipped yet?"
 *
 * Runs offline on the mock by default, so it works on a fresh clone.
 *
 * ---------------------------------------------------------------------------
 * Every example in this repo, in one program
 * ---------------------------------------------------------------------------
 *
 *   01, 04  Nothing the model says is trusted. Tool arguments and the final
 *           structured answer both go through Zod before anything reads them.
 *   03      The tool calls in one round run concurrently, because a model can
 *           ask for three lookups at once and there is no reason to queue them.
 *   05      --json asks the provider to enforce the answer's shape, and then
 *           validates it anyway.
 *   06      The reply is a block list; the loop switches on `block.type`.
 *   07      `runTool` is the only thing allowed to open a `tool_use` input.
 *   08      The final answer streams; Ctrl-C and --timeout both cancel it.
 *   09      Every failure path is narrowed from `unknown` before it is reported.
 *   12      One process, one loop: no CPU work happens in the request path.
 *
 * ---------------------------------------------------------------------------
 * The one design decision worth explaining
 * ---------------------------------------------------------------------------
 *
 * Tool rounds are NOT streamed; the final answer is. That is not laziness. You
 * cannot act on half a tool call: the arguments arrive as JSON fragments and
 * mean nothing until the last one lands. So the loop runs unstreamed until the
 * model stops asking for tools, then makes one final streamed call for the
 * prose. Example 08 measures why.
 */

import { parseArgs } from "node:util";
import { z } from "zod";
import { bold, cyan, dim, green, heading, ms, red, yellow } from "../tsai/fmt.ts";
import { chat, describe, providerName, stream } from "../tsai/providers.ts";
import { parseModelJson } from "../tsai/schema.ts";
import { ORDER_TOOLS, runTool } from "../tsai/tools.ts";
import { toolUsesOf } from "../tsai/types.ts";
import type { ContentBlock, Msg } from "../tsai/types.ts";

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const { values, positionals } = parseArgs({
  options: {
    json: { type: "boolean", default: false },
    trace: { type: "boolean", default: false },
    timeout: { type: "string", default: "30000" },
    rounds: { type: "string", default: "4" },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: true,
});

const question = positionals.join(" ").trim();

if (values.help || !question) {
  console.log(`
${bold("ask")} - answer questions about the orders dataset, using tools.

  npx tsx hands_on/ask.ts "<question>" [options]

  --json           return a validated structured answer instead of prose
  --trace          show every tool call and its result
  --timeout <ms>   give up after this long (default 30000)
  --rounds <n>     maximum tool rounds (default 4)
  -h, --help       this message

Try:
  npx tsx hands_on/ask.ts "What is the status of order A-1003?"
  npx tsx hands_on/ask.ts "Which orders are still pending?" --trace --json
`);
  process.exit(question ? 0 : 2);
}

const timeoutMs = Number(values.timeout);
const maxRounds = Number(values.rounds);
if (!Number.isFinite(timeoutMs) || !Number.isFinite(maxRounds)) {
  console.error("--timeout and --rounds must be numbers.");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Cancellation: a deadline and a Ctrl-C, composed into one signal.
//
// AbortSignal.any is the piece that makes this pleasant. Two independent
// reasons to stop, one signal handed to every call below, and no bookkeeping.
// ---------------------------------------------------------------------------

const userCancel = new AbortController();
process.on("SIGINT", () => {
  process.stdout.write(dim("\n(cancelled)\n"));
  userCancel.abort();
});
const signal = AbortSignal.any([userCancel.signal, AbortSignal.timeout(timeoutMs)]);

// ---------------------------------------------------------------------------

const SYSTEM = [
  "You answer questions about a small orders dataset.",
  "Use the tools to look things up. Never guess an order's details.",
  "If the tools cannot answer the question, say so plainly.",
].join(" ");

/**
 * The last turn needs different instructions, and finding that out cost a run.
 *
 * The final call is made WITHOUT tools, because it is streamed (see the note at
 * the top of this file). A model that still wanted another lookup then produces
 * something like "let me check whether there are more orders" and stops, which
 * is a reasonable thing to say and a useless thing to return to a user.
 *
 * So the final turn says the affordance is gone. The model's options are now to
 * answer from what it has, or to say it cannot.
 */
const FINAL_SYSTEM = [
  SYSTEM,
  "You have now received all the tool results you are going to get, and no",
  "further tools are available. Answer the question using only the information",
  "above. If it is not enough, say exactly what is missing.",
].join(" ");

const AnswerSchema = z.object({
  answer: z.string().describe("the answer in one or two sentences"),
  orderIds: z.array(z.string()).describe("every order id the answer refers to"),
  answeredFromTools: z.boolean().describe("false if the tools did not provide the facts"),
});

type Trace = { tool: string; input: unknown; ok: boolean; result: string; ms: number };

/** Run the tool rounds. Returns the conversation, ready for a final answer. */
async function runToolRounds(): Promise<{ messages: Msg[]; trace: Trace[] }> {
  const messages: Msg[] = [{ role: "user", content: question }];
  const trace: Trace[] = [];

  for (let round = 0; round < maxRounds; round++) {
    const reply = await chat({ system: SYSTEM, messages, tools: ORDER_TOOLS, signal });
    const calls = toolUsesOf(reply.blocks);
    if (calls.length === 0) return { messages, trace };

    messages.push({ role: "assistant", content: reply.blocks });

    // Example 03: a model can ask for several lookups in one turn. They are
    // independent, so run them together rather than one after another.
    const results = await Promise.all(
      calls.map(async (call): Promise<ContentBlock> => {
        const started = performance.now();
        // Example 07: `call.input` is `unknown`. runTool validates before acting.
        const outcome = runTool(call.name, call.input);
        trace.push({
          tool: call.name,
          input: call.input,
          ok: outcome.ok,
          result: outcome.content,
          ms: performance.now() - started,
        });
        return {
          type: "tool_result",
          toolUseId: call.id,
          content: outcome.content,
          isError: !outcome.ok,
        };
      }),
    );
    messages.push({ role: "user", content: results });
  }

  return { messages, trace };
}

/** Narrow whatever was thrown into something worth printing. */
function explain(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError") return `gave up after ${ms(timeoutMs)}`;
    if (error.name === "AbortError" || /abort/i.test(error.message)) return "cancelled";
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

// ---------------------------------------------------------------------------

const started = performance.now();
console.log(dim(`provider: ${describe()}`));
console.log(`${bold("Q:")} ${question}\n`);

try {
  const { messages, trace } = await runToolRounds();

  if (values.trace) {
    console.log(heading("tool calls"));
    if (trace.length === 0) console.log(dim("  (none: the model answered without tools)"));
    for (const entry of trace) {
      const status = entry.ok ? green("ok") : red("rejected");
      console.log(
        `  ${cyan(entry.tool)}(${JSON.stringify(entry.input)}) ${status} ${dim(ms(entry.ms))}\n` +
          `    ${dim(entry.result)}`,
      );
    }
    console.log("");
  }

  if (values.json) {
    // Example 05: ask the provider to enforce the shape, then validate anyway.
    const structured = await chat({
      system: FINAL_SYSTEM,
      messages,
      responseSchema: AnswerSchema,
      responseSchemaName: "answer",
      signal,
    });
    const parsed = parseModelJson(structured.text, AnswerSchema);
    if (!parsed.ok) {
      console.error(`${red("the model's structured answer did not validate:")} ${parsed.error}`);
      console.error(dim(`raw: ${structured.text.slice(0, 200)}`));
      process.exit(1);
    }
    console.log(JSON.stringify(parsed.value, null, 2));
    if (!parsed.value.answeredFromTools) {
      console.error(
        yellow("\nnote: the model says the tools did not provide these facts. Treat with care."),
      );
    }
  } else {
    // Example 08: stream the prose, and check afterwards whether it finished.
    process.stdout.write(bold("A: "));
    let characters = 0;
    for await (const event of stream({ system: FINAL_SYSTEM, messages, signal })) {
      if (event.type === "text_delta") {
        characters += event.text.length;
        process.stdout.write(event.text);
      }
    }
    process.stdout.write("\n");
    if (signal.aborted) {
      console.error(yellow("\nthe answer above is incomplete: the request was cancelled."));
      process.exit(1);
    }
    if (characters === 0) console.error(yellow("the model returned nothing."));
  }

  console.log(dim(`\n${ms(performance.now() - started)} total, ${providerName()}`));
} catch (error) {
  // Example 09: `error` is unknown here, and one of these paths is a cancel,
  // which is not a failure. Both still have to be reported honestly.
  console.error(`\n${red("failed:")} ${explain(error)}`);
  process.exit(1);
}
