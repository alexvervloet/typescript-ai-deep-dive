/**
 * Example 13: measure the ecosystem instead of arguing about it (network, no key).
 *
 * "The AI tooling is all in Python" is the objection this dive gets, and it is
 * half true in a way that is worth pinning down rather than asserting. So this
 * example asks the registries.
 *
 * For each job an AI engineer actually has, it looks up the Python package and
 * the TypeScript one, on PyPI and npm, and reports whether an equivalent exists,
 * when it was last published, and how much it is used. Every number is fetched
 * live, so this file does not go stale the way a hand-written table would.
 *
 * Read it carefully, because it is easy to over-read:
 *
 *   - Download counts are NOT comparable across ecosystems. npm counts are
 *     inflated by CI installs and transitive dependencies in a way PyPI's are
 *     not. Compare within a column, never across.
 *   - Downloads measure adoption, not quality. A small, excellent library and an
 *     abandoned popular one look similar here.
 *   - "Last published" is the honest signal, and the one to actually read.
 *
 * Needs network access but no API key and no account:
 *
 *     npx tsx examples/13_ecosystem_check.ts
 */

import { bold, cyan, dim, green, heading, red, table, yellow } from "../tsai/fmt.ts";

type Pair = {
  job: string;
  pypi: string;
  npm: string | null;
  note?: string;
};

const PAIRS: Pair[] = [
  { job: "schema + validation", pypi: "pydantic", npm: "zod" },
  { job: "tokenizer", pypi: "tiktoken", npm: "gpt-tokenizer" },
  { job: "RAG framework", pypi: "llama-index", npm: "llamaindex" },
  { job: "agent graphs", pypi: "langgraph", npm: "@langchain/langgraph" },
  { job: "tracing", pypi: "langfuse", npm: "langfuse" },
  { job: "structured extraction", pypi: "instructor", npm: "@instructor-ai/instructor" },
  { job: "eval harness", pypi: "deepeval", npm: "promptfoo", note: "different design, same job" },
  { job: "provider abstraction", pypi: "litellm", npm: "ai", note: "Vercel AI SDK, not a port" },
  { job: "training / LoRA", pypi: "peft", npm: null, note: "no equivalent exists" },
];

type Facts = {
  version: string;
  lastPublished: Date | null;
  weeklyDownloads: number | null;
};

const HEADERS = { "user-agent": "typescript-ai-deep-dive/1.0 (teaching example)" };

const wait = (msValue: number) => new Promise((resolve) => setTimeout(resolve, msValue));

async function fetchJson(url: string, retryOn429 = true): Promise<unknown | null> {
  try {
    const response = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(8000) });
    // A real 429, from a real public API, in an example that spent section 03
    // explaining why unbounded concurrency earns you one. Back off and try once.
    if (response.status === 429 && retryOn429) {
      await wait(1500);
      return fetchJson(url, false);
    }
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function npmFacts(name: string): Promise<Facts | null> {
  const meta = (await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(name)}`)) as {
    "dist-tags"?: { latest?: string };
    time?: Record<string, string>;
  } | null;
  if (!meta?.["dist-tags"]?.latest) return null;
  const version = meta["dist-tags"].latest;
  const published = meta.time?.[version];

  const downloads = (await fetchJson(
    `https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(name)}`,
  )) as { downloads?: number } | null;

  return {
    version,
    lastPublished: published ? new Date(published) : null,
    weeklyDownloads: downloads?.downloads ?? null,
  };
}

async function pypiFacts(name: string): Promise<Facts | null> {
  const meta = (await fetchJson(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`)) as {
    info?: { version?: string };
    urls?: Array<{ upload_time_iso_8601?: string }>;
  } | null;
  if (!meta?.info?.version) return null;

  const uploaded = meta.urls?.[0]?.upload_time_iso_8601;
  return {
    version: meta.info.version,
    lastPublished: uploaded ? new Date(uploaded) : null,
    weeklyDownloads: null, // see the note under the table
  };
}

function monthsSince(date: Date | null): string {
  if (!date) return dim("unknown");
  const months = (Date.now() - date.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
  if (months < 1) return green("this month");
  if (months < 3) return green(`${Math.round(months)}mo ago`);
  if (months < 12) return yellow(`${Math.round(months)}mo ago`);
  return red(`${(months / 12).toFixed(1)}y ago`);
}

function compact(n: number | null): string {
  if (n === null) return dim("?");
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

// ---------------------------------------------------------------------------

console.log(heading("Asking the registries"));
console.log(`\n  ${dim(`${PAIRS.length} pairs, fetched live from PyPI and npm, four at a time`)}`);

/** Example 03's concurrency limiter, doing a real job. Both registries are
 * polite about bursts; four at a time is neighborly and still fast. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
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

const started = performance.now();
const rows = await mapLimit(PAIRS, 4, async (pair) => {
  const [python, node] = await Promise.all([
    pypiFacts(pair.pypi),
    pair.npm ? npmFacts(pair.npm) : Promise.resolve(null),
  ]);
  return { pair, python, node };
});
const elapsed = performance.now() - started;

const anyData = rows.some((r) => r.python !== null || r.node !== null);
if (!anyData) {
  console.log(`
  ${yellow("Could not reach either registry.")} This example needs network access (but
  no key and no account). Everything else in the repo runs offline.`);
  process.exit(0);
}

console.log(
  "\n" +
    table(
      [
        { header: "job" },
        { header: "PyPI" },
        { header: "published" },
        { header: "npm" },
        { header: "published" },
        { header: "npm/wk", align: "right" },
      ],
      rows.map(({ pair, python, node }) => [
        pair.job,
        pair.pypi,
        monthsSince(python?.lastPublished ?? null),
        pair.npm ?? red("none"),
        pair.npm ? monthsSince(node?.lastPublished ?? null) : dim("-"),
        pair.npm ? compact(node?.weeklyDownloads ?? null) : dim("-"),
      ]),
    ),
);

console.log(`\n  ${dim(`fetched in ${Math.round(elapsed)}ms`)}`);

for (const { pair } of rows) {
  if (pair.note) console.log(`  ${dim(`${pair.job}: ${pair.note}`)}`);
}

// ---------------------------------------------------------------------------

console.log(heading("How to read that table"));

const missing = rows.filter((r) => r.pair.npm === null || r.node === null);
const stale = rows.filter((r) => {
  const published = r.node?.lastPublished;
  if (!published) return false;
  return (Date.now() - published.getTime()) / (1000 * 60 * 60 * 24 * 30.44) > 12;
});

console.log(`
  ${bold("There is deliberately no PyPI download column.")} An earlier version had one
  and it was removed for two reasons, both worth knowing.

  The honest reason: the counts are not comparable. An npm number includes every
  CI run and every transitive install; a PyPI number does not. Putting them side
  by side and drawing a conclusion would be exactly the kind of chart that looks
  rigorous and argues nothing. The npm column stays because comparing ${cyan("zod")} to
  ${cyan("@instructor-ai/instructor")} within one registry ${bold("is")} meaningful.

  The practical reason: pypistats.org returns ${yellow("429 Too Many Requests")} for a burst
  of nine lookups, which this example discovered by doing it. Example 03's
  "all at once is the wrong default" is not a hypothetical; it is the first thing
  that happens when you point ${cyan("Promise.all")} at somebody else's free API. Fetching
  them one at a time worked, took thirteen seconds, and still lost four rows.

  On this run: ${
    missing.length === 0
      ? green("every job had a TypeScript package.")
      : `${red(`${missing.length} of ${rows.length}`)} jobs had no maintained TypeScript equivalent.`
  }${stale.length > 0 ? ` ${yellow(`${stale.length} more`)} had not been published in over a year.` : ""}

  ${bold("The shape of the answer, which the numbers keep confirming:")}

    ${green("Application-layer work ports cleanly.")} Validation, tokenizing,
    tracing, retrieval, agent graphs and evals all have real, maintained
    TypeScript packages, several of them first-party ports by the same teams.

    ${yellow("Framework-layer work is thinner.")} The TypeScript versions tend to be
    younger, smaller, and a release or two behind their Python siblings. You will
    hit a missing feature eventually.

    ${red("Training does not port at all.")} Fine-tuning, LoRA, quantization,
    anything that touches weights: PyTorch, PEFT, TRL and MLX are Python, and no
    TypeScript equivalent is coming, because the ecosystem those libraries sit in
    is Python all the way down to the CUDA bindings.

  ${bold("Which lines up with what this repo has been arguing.")} Everything the other
  twelve examples cover (calling models, validating output, tools, streaming,
  serving, cancelling, counting tokens) is application-layer work, and it is
  entirely at home in TypeScript. If your job includes training models, keep
  Python for that part and do not fight it.`);
