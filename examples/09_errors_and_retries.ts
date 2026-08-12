/**
 * Example 09: what you caught, and what nobody caught (offline, no API call).
 *
 * Three things about failure change when you move this code from Python:
 *
 *   1. You do not know what you caught. JavaScript can throw any value, so a
 *      caught error is typed `unknown` and you have to prove what it is.
 *   2. Retrying is hand-rolled. There is no `tenacity`, and neither SDK's
 *      default retry policy covers a streamed response mid-flight.
 *   3. A rejected promise nobody awaited will terminate the process. Not warn.
 *      Terminate. That one has no Python equivalent and it is the one that
 *      takes production down.
 *
 *     npx tsx examples/09_errors_and_retries.ts
 */

import { bold, cyan, dim, green, heading, ms, red, table, yellow } from "../tsai/fmt.ts";
import { errorsIn } from "../tsai/compiler.ts";
import { MockTransientError, mockBehavior, resetMockBehavior, sleep } from "../tsai/mock.ts";
import { chat } from "../tsai/providers.ts";

resetMockBehavior();

// ---------------------------------------------------------------------------

console.log(heading("1. You do not know what you caught"));

for (const line of await errorsIn("broken/catch_unknown.ts")) {
  console.log(`    ${red(line)}`);
}

console.log(`
  Under ${cyan("strict")}, the caught value is ${cyan("unknown")}. Not ${cyan("Error")}, not ${cyan("any")}. The
  compiler is being accurate rather than difficult: ${dim('throw "nope"')} is legal
  JavaScript, ${dim("throw { code: 42 }")} is legal, and a rejected promise can carry any
  value at all. Python's ${dim("except Exception as e")} can promise you an exception
  object because Python only lets you raise those. JavaScript made no such rule.

  So you narrow, and the narrowing is the code you will write a hundred times:`);

/** The shape every provider error has in common, once you have checked. */
function describeError(error: unknown): { kind: string; status: number | null; message: string } {
  if (error instanceof MockTransientError) {
    return { kind: error.name, status: error.status, message: error.message };
  }
  if (error instanceof Error) {
    // Both SDKs put an HTTP status on their API errors. Reading it off an
    // `Error` needs a check, because plain Errors do not have one.
    const status = "status" in error && typeof error.status === "number" ? error.status : null;
    return { kind: error.name, status, message: error.message };
  }
  // The case people forget. Something was thrown that is not an Error at all.
  return { kind: typeof error, status: null, message: String(error) };
}

const thrown: unknown[] = [
  new MockTransientError(),
  new Error("network socket hang up"),
  Object.assign(new Error("Rate limit reached"), { status: 429 }),
  "a bare string, thrown by some dependency",
  { code: 42 },
];

console.log(
  "\n" +
    table(
      [{ header: "thrown value" }, { header: "kind" }, { header: "status" }, { header: "message" }],
      thrown.map((value) => {
        const described = describeError(value);
        return [
          typeof value === "object" && value !== null ? value.constructor.name : typeof value,
          described.kind,
          described.status === null ? dim("none") : String(described.status),
          described.message.slice(0, 40),
        ];
      }),
    ),
);

// ---------------------------------------------------------------------------

console.log(heading("2. Retrying, from scratch"));

/**
 * Retry a call that might fail transiently.
 *
 * Twenty lines, no dependency, and worth writing yourself once so you know what
 * your policy actually is. The parts that matter:
 *
 *   - Only retry what is worth retrying. A 400 will fail identically forever;
 *     retrying it burns your budget and your latency on a certainty.
 *   - Back off exponentially, so a struggling provider gets quieter traffic
 *     rather than the same traffic.
 *   - Add jitter. Without it, every client that failed at the same moment
 *     retries at the same moment, and you have rebuilt the outage.
 *   - Respect the deadline. A retry loop with no signal is how one slow request
 *     becomes a thread of them.
 */
async function withRetries<T>(
  fn: () => Promise<T>,
  options: { attempts?: number; baseMs?: number; signal?: AbortSignal } = {},
): Promise<{ value: T; attempts: number; waitedMs: number }> {
  const attempts = options.attempts ?? 4;
  const baseMs = options.baseMs ?? 50;
  let waitedMs = 0;

  for (let attempt = 1; ; attempt++) {
    try {
      return { value: await fn(), attempts: attempt, waitedMs };
    } catch (error) {
      const { status } = describeError(error);
      const retryable = status === null || status === 429 || status >= 500;
      if (!retryable || attempt >= attempts) throw error;

      const backoff = baseMs * 2 ** (attempt - 1);
      const jitter = Math.random() * backoff * 0.3;
      const wait = Math.round(backoff + jitter);
      waitedMs += wait;
      console.log(
        `    ${yellow(`attempt ${attempt} failed`)} (${status ?? "no status"}), ` +
          `retrying in ${ms(wait)}`,
      );
      await sleep(wait, options.signal);
    }
  }
}

mockBehavior.failNext = 2; // fail twice, then succeed
console.log("");
const outcome = await withRetries(() =>
  chat({ system: "Be brief.", messages: [{ role: "user", content: "order A-1003" }] }),
);
console.log(`
  ${green(`succeeded on attempt ${outcome.attempts}`)} after waiting ${ms(outcome.waitedMs)} in total.
  ${dim(`answer: ${outcome.value.text.slice(0, 60)}...`)}

  Both SDKs do retry automatically (two extra attempts by default), which covers
  the simple case and is genuinely good. What it does not cover is a stream that
  dies after the first token, a tool result that failed validation, or your own
  policy about which errors deserve a second try. Once your call is wrapped in
  anything, the retry belongs at your layer.`);

// ---------------------------------------------------------------------------

console.log(heading("3. The failure with no stack trace"));

// Register a handler so this example can demonstrate the problem without
// actually dying. Without this handler, Node prints the error and exits 1.
let unhandledSeen = false;
process.on("unhandledRejection", (reason) => {
  unhandledSeen = true;
  console.log(`
    ${red("unhandledRejection")}: ${describeError(reason).message}
    ${dim("no stack pointing at the line that forgot to await")}`);
});

mockBehavior.failNext = 1;

// The bug: a promise created, never awaited, that rejects. This is the same
// shape as example 03's forEach, and it is why that one mattered.
void chat({ system: "s", messages: [{ role: "user", content: "hello" }] });

await sleep(120); // let the rejection land

console.log(`
  ${unhandledSeen ? green("The rejection above had no owner.") : yellow("(no rejection observed on this run)")}

  ${bold("Without that handler, this is fatal.")} Since Node 15 an unhandled rejection
  terminates the process rather than warning about it. Check for yourself:

    ${dim(`node -e 'Promise.reject(new Error("boom")); setTimeout(() => console.log("alive"), 100)'`)}

  prints the error and exits 1. "alive" never runs. One forgotten ${cyan("await")} in a
  background task, on a code path that only fails when a provider is having a bad
  afternoon, takes down a server that was otherwise healthy.

  Python's equivalent is milder. A coroutine you never awaited prints
  "coroutine was never awaited" and the interpreter keeps going.

  The defenses, in order of how much they help:

    ${green("await everything")}, or explicitly ${cyan("void")} it after attaching a ${cyan(".catch()")}
    ${green("no-floating-promises")}, the typescript-eslint rule that finds these statically
    ${green("process.on(\"unhandledRejection\")")}, so the last-resort log is yours, not Node's`);

resetMockBehavior();

console.log(`
${heading("What to take from this")}
  The first two are places TypeScript asks for work Python did for you: proving
  what you caught, and deciding your own retry policy. Both are a fair trade, and
  both take an afternoon once.

  The third is not a language preference, it is a hazard. An un-awaited rejection
  is a process-level failure with no stack trace pointing at the omission, and
  the only reliable defense is a lint rule, because there is nothing on the page
  to review. If you take one configuration change from this repo into a real
  project, make it ${cyan("@typescript-eslint/no-floating-promises")}.`);
