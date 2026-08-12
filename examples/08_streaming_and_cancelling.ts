/**
 * Example 08: streaming is an async iterator, and stopping is a signal (offline).
 *
 * Streaming in TypeScript is the place where the language's shape and the
 * problem's shape line up best. A stream of tokens is exactly an async
 * iterable, so consuming one is a `for await` loop, and the loop reads like the
 * synchronous loop it replaced.
 *
 *     for await (const event of stream({ messages })) { ... }
 *
 * Cancellation is the half that people skip, and it is the half that matters in
 * production: a user closes the tab, a request times out, a cheaper answer
 * arrives first. In Node the mechanism is standard and it is the same one used
 * by `fetch`, timers, streams and both SDKs: an `AbortSignal`.
 *
 * Runs on the offline mock, so the pacing below is simulated but the mechanics
 * are exactly what a real provider does:
 *
 *     npx tsx examples/08_streaming_and_cancelling.ts
 *     PROVIDER=openai secrun npx tsx examples/08_streaming_and_cancelling.ts
 */

import { bold, cyan, dim, green, heading, ms, red, yellow } from "../tsai/fmt.ts";
import { resetMockBehavior } from "../tsai/mock.ts";
import { describe, stream } from "../tsai/providers.ts";

resetMockBehavior();
console.log(`Provider: ${describe()}`);

const QUESTION = "In three sentences, explain what a Promise is in JavaScript.";

// ---------------------------------------------------------------------------

console.log(heading("1. The loop"));
console.log(`
    ${dim("for await (const event of stream({ messages })) {")}
    ${dim("  if (event.type === \"text_delta\") process.stdout.write(event.text);")}
    ${dim("}")}
`);

const started = performance.now();
let firstTokenAt = 0;
let tokens = 0;

process.stdout.write("  ");
for await (const event of stream({ system: "Be brief.", messages: [{ role: "user", content: QUESTION }] })) {
  switch (event.type) {
    case "text_delta":
      if (firstTokenAt === 0) firstTokenAt = performance.now();
      tokens += 1;
      process.stdout.write(event.text);
      break;
    case "tool_use":
      process.stdout.write(dim(`[tool: ${event.name}]`));
      break;
    case "done":
      process.stdout.write("\n");
      break;
  }
}

const total = performance.now() - started;
console.log(`
  ${dim(`first token after ${ms(firstTokenAt - started)}, ${tokens} deltas, ${ms(total)} total`)}

  ${bold("Time to first token is the number streaming actually improves.")} The total
  did not get shorter. What changed is that the user saw something after
  ${ms(firstTokenAt - started)} instead of ${ms(total)}, and that is the whole product argument.

  The event union is discriminated the same way content blocks are (example 06),
  so the ${cyan("switch")} above is exhaustive and a new event type would break the build
  rather than being silently ignored.`);

// ---------------------------------------------------------------------------

console.log(heading("2. Stopping early"));

// Abort once we have seen 40 characters, not 40 events. How many events a
// provider splits an answer into is an implementation detail that varies a lot:
// the mock emits one word at a time, Claude sometimes sends a whole paragraph in
// four. Counting characters makes this section behave the same everywhere.
const controller = new AbortController();
let characters = 0;
let deltas = 0;
let threw: string | null = null;

process.stdout.write("  ");
try {
  for await (const event of stream({
    system: "Be brief.",
    messages: [{ role: "user", content: QUESTION }],
    signal: controller.signal,
  })) {
    if (event.type !== "text_delta") continue;
    deltas += 1;
    characters += event.text.length;
    process.stdout.write(event.text);
    if (characters >= 40 && !controller.signal.aborted) controller.abort();
  }
} catch (error) {
  threw = error instanceof Error ? error.name : String(error);
}

console.log(`\n
  We called ${cyan("controller.abort()")} after ${characters} characters (${deltas} deltas).
  The stream stopped: the text above is cut off mid-answer.

  ${bold("Did it throw?")} ${
    threw
      ? red(`Yes, ${threw}.`)
      : yellow("No. The loop simply ended, with no error at all.")
  }

  ${bold("That answer is not the same on every stack, which is the lesson.")} Three
  stacks, three behaviors, all measured on this example:

    ${cyan("mock")}      throws, ${dim("error.name === \"AbortError\"")}
    ${cyan("openai")}    does not throw. The loop just ends, exactly as if the
              model had stopped talking.
    ${cyan("claude")}    throws ${dim("APIUserAbortError(\"Request was aborted.\")")}, whose
              ${dim("name")} is the unhelpful ${dim("\"Error\"")}, so matching on name fails.

  If you were planning to write ${dim('catch (e) { if (e.name === "AbortError") ... }')},
  two of those three would fall through to your generic error handler and get
  logged as a real failure. So neither half of the handling is optional:

    ${green("try { for await (...) } catch (e) { ... }")}   ${dim("// it might throw")}
    ${green("if (controller.signal.aborted) { ... }")}      ${dim("// it might not")}

  Checking the flag after the loop is what tells a truncated answer apart from a
  complete one. Without it, a cancelled generation looks like a finished one, and
  you cache it, or show it, or feed it to the next step.

  Two ways to raise the signal:

    ${green("controller.abort()")}                    ${dim("// you decide when")}
    ${green("AbortSignal.timeout(2000)")}             ${dim("// a deadline, built in")}

  Either way the signal goes all the way down. Both SDKs hand it to ${cyan("fetch")}, which
  closes the connection, which stops the provider generating, which stops the
  meter. A bare ${cyan("break")} would stop your loop and leave the request running and
  billing.`);

// ---------------------------------------------------------------------------

console.log(heading("3. A deadline"));

const deadline = AbortSignal.timeout(150);
let beforeDeadline = 0;
try {
  for await (const event of stream({
    system: "Be brief.",
    messages: [{ role: "user", content: QUESTION }],
    signal: deadline,
  })) {
    if (event.type === "text_delta") beforeDeadline += 1;
  }
  console.log(`\n  finished within the deadline (${beforeDeadline} deltas)`);
} catch (error) {
  const name = error instanceof Error ? error.name : String(error);
  console.log(
    `\n  ${yellow(`${beforeDeadline} deltas arrived, then the 150ms deadline fired: ${name}`)}`,
  );
}

console.log(`
  ${cyan("AbortSignal.timeout(ms)")} is one line and needs no cleanup. Compare the Python
  spelling, ${dim("asyncio.wait_for(...)")}, which wraps the coroutine instead of being
  handed to it, or a per-request timeout argument that each SDK spells its own
  way. Node picked one mechanism and used it everywhere, and that consistency is
  a genuine advantage when you are composing a fetch, a database call and a model
  call under one deadline.`);

// ---------------------------------------------------------------------------

console.log(heading("4. What streaming costs you"));

console.log(`
  Streaming is not free, and the price is paid in the two places this repo has
  spent its time:

  ${bold("You cannot validate what you have already shown.")} Example 04's whole
  discipline is to parse before you trust. A streamed answer is on the user's
  screen before the last token exists, so an output guardrail can only redact
  what it has not yet printed. Systems that need both usually stream to a buffer,
  check, then release, which gives up most of the latency win, or they stream
  and accept that a retraction is sometimes visible.

  ${bold("Structured output and streaming pull in opposite directions.")} Half a JSON
  object does not parse. Both SDKs will hand you partial-JSON fragments for tool
  arguments, and reassembling them is real work: on OpenAI you concatenate string
  fragments per tool-call index yourself, which tsai/providers.ts does in about
  fifteen lines. Anthropic's SDK does it for you and exposes ${cyan("finalMessage()")}.
  Either way you cannot act on a tool call until it is complete, so the capstone
  streams the final prose and does its tool rounds unstreamed. That is not a
  workaround, it is the honest structure of the problem.`);
