/**
 * Example 03: async is not a mode you opt into (offline, no API call).
 *
 * The single structural difference between the Python in the sibling dives and
 * the TypeScript here: there is no synchronous version of anything. Node's only
 * network I/O is asynchronous, so `chat()` returns a Promise, and so does every
 * function that calls it, all the way up.
 *
 * Python makes you choose. `openai.OpenAI()` and `openai.AsyncOpenAI()` are two
 * different clients, `def` and `async def` are two different worlds, and the
 * sibling dives quite reasonably stay in the synchronous one until an example
 * specifically needs concurrency. Node deleted that choice. It costs you an
 * `await` on your hello-world, and it hands you the concurrency for free.
 *
 * This example measures what "for free" is worth, and then shows the two ways
 * the free thing bites.
 *
 * All timings below come from the offline mock, whose simulated round trip is
 * 40ms. No key, no network, no cost:
 *
 *     npx tsx examples/03_async_by_default.ts
 */

import { bold, cyan, dim, green, heading, ms, red, table, yellow } from "../tsai/fmt.ts";
import { mockBehavior, resetMockBehavior } from "../tsai/mock.ts";
import { chat } from "../tsai/providers.ts";

const QUESTIONS = [
  "order A-1001",
  "order A-1002",
  "order A-1003",
  "order A-1004",
  "order A-1005",
  "order A-1006",
];

resetMockBehavior();

async function ask(question: string): Promise<string> {
  const reply = await chat({ system: "Answer briefly.", messages: [{ role: "user", content: question }] });
  return reply.text;
}

/** Time an async function, in milliseconds. */
async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const started = performance.now();
  const value = await fn();
  return [value, performance.now() - started];
}

/**
 * Run `fn` over `items`, at most `limit` at a time.
 *
 * Fifteen lines, no dependency. Worth writing out once because `Promise.all`
 * over a hundred prompts is how people discover their provider's rate limit,
 * and because the shape (N workers pulling from a shared cursor) is the same one
 * you would write in any language.
 */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ---------------------------------------------------------------------------

console.log(heading("1. Six calls, three ways"));

const [, sequentialMs] = await timed(async () => {
  const out: string[] = [];
  for (const question of QUESTIONS) out.push(await ask(question));
  return out;
});

const [, parallelMs] = await timed(async () => Promise.all(QUESTIONS.map(ask)));

const [, limitedMs] = await timed(async () => mapLimit(QUESTIONS, 2, ask));

console.log(
  "\n" +
    table(
      [{ header: "strategy" }, { header: "code" }, { header: "wall clock", align: "right" }],
      [
        ["sequential", "for (const q of qs) await ask(q)", ms(sequentialMs)],
        ["all at once", "await Promise.all(qs.map(ask))", ms(parallelMs)],
        ["at most 2", "await mapLimit(qs, 2, ask)", ms(limitedMs)],
      ],
    ),
);

console.log(`
  The mock's round trip is 40ms, so six sequential calls cost about 240ms and
  six concurrent ones cost about one round trip. ${bold("The parallel version is not")}
  ${bold("an optimization you added; it is what you get when the language has no")}
  ${bold("blocking call to offer.")} Python can do this too, with asyncio.gather, but
  you have to convert your whole call stack to async first.

  ${bold("The honest catch:")} "all at once" is the wrong default against a real
  provider. Six is fine; six hundred is a wall of 429s, and every one of them
  costs you a retry. That is what ${cyan("mapLimit")} is for, and why the middle row is
  the one you actually ship.`);

// ---------------------------------------------------------------------------

console.log(heading("2. The footgun: forEach does not wait"));

const collected: string[] = [];
QUESTIONS.forEach(async (question) => {
  collected.push(await ask(question));
});

console.log(`
    ${dim("questions.forEach(async (q) => { collected.push(await ask(q)); });")}
    ${dim("console.log(collected.length);")}

  Right after the loop, collected.length is ${red(String(collected.length))}.

  ${cyan("forEach")} was written before promises existed. It calls your function, gets a
  Promise back, and throws it away. The loop "finishes" instantly with nothing
  done, and any error inside becomes an unhandled rejection with no stack trace
  pointing here. There is no compile error, because the callback's return type is
  allowed to be anything.

  The two correct spellings:

    ${green("for (const q of questions) collected.push(await ask(q));")}   ${dim("// sequential")}
    ${green("const all = await Promise.all(questions.map(ask));")}         ${dim("// concurrent")}`);

// Let the abandoned promises settle so the process does not exit mid-flight.
await new Promise((resolve) => setTimeout(resolve, 200));
console.log(`
  ${dim(`(200ms later the abandoned promises have finished and collected.length is ${collected.length}.`)}
  ${dim("They ran. Nobody was waiting.)")}`);

// ---------------------------------------------------------------------------

console.log(heading("3. The other footgun: Promise.all is all or nothing"));

mockBehavior.failNext = 1; // the first call of the batch fails

const allResult = await Promise.all(QUESTIONS.map(ask)).then(
  (values) => `${green("resolved")} with ${values.length} answers`,
  (error) => `${red("rejected")}: ${(error as Error).message}`,
);

mockBehavior.failNext = 1;
const settled = await Promise.allSettled(QUESTIONS.map(ask));
const okCount = settled.filter((r) => r.status === "fulfilled").length;

console.log(`
    ${dim("await Promise.all(...)")}         ${allResult}
    ${dim("await Promise.allSettled(...)")}  ${green(`${okCount} of ${settled.length} succeeded`)}, 1 failed, all results kept

  ${cyan("Promise.all")} rejects the moment any one promise rejects, and the five
  answers that did arrive are thrown away with it. For a batch of model calls,
  where one 503 out of fifty is normal, ${bold("allSettled is almost always what you")}
  ${bold("meant")}. Python's asyncio.gather has the same fork in the road, spelled
  ${yellow("return_exceptions=True")}.`);

resetMockBehavior();

console.log(`
${heading("What to take from this")}
  Node made the concurrent thing the easy thing, then left both of its sharp
  edges (a loop that does not wait, a batch that discards partial results) as
  ordinary code with no compile error. The compiler will not save you here.
  Example 09 covers the third edge: what happens to an error nobody awaited.`);
