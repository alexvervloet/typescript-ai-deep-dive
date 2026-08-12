/**
 * Example 10: what Python's standard library was doing for you (offline).
 *
 * The Python dives lean on the standard library constantly and invisibly:
 * `statistics` for eval scores, `argparse` for every CLI, `@dataclass` for every
 * record, f-strings for every number. None of those exist in Node.
 *
 * This example rebuilds the missing pieces by writing an eval scorer, which is
 * the most Python-flavored thing in the whole series, and then counts the cost
 * honestly. The answer is smaller than the reputation suggests, and one item on
 * the list goes the other way.
 *
 *     npx tsx examples/10_the_stdlib_gap.ts
 *     npx tsx examples/10_the_stdlib_gap.ts --threshold 0.8 --format json
 */

import { parseArgs } from "node:util";
import { bold, cyan, dim, green, heading, red, table, yellow } from "../tsai/fmt.ts";

// ---------------------------------------------------------------------------
// 1. argparse -> node:util parseArgs
//
// In the standard library since Node 18.3, which is the good news. The bad news
// is that it is a parser, not a framework: no help text, no subcommands, no
// types beyond string and boolean, no validation. argparse gives you all four.
// For a script this is fine. For a real CLI you reach for commander or citty,
// the way a real Python CLI reaches for click.
// ---------------------------------------------------------------------------

const { values } = parseArgs({
  options: {
    threshold: { type: "string", default: "0.7" },
    format: { type: "string", default: "table" },
  },
  allowPositionals: false,
});

// Note the cast that is not a cast: parseArgs gives you strings, so the number
// conversion is yours, and so is the error when someone passes --threshold cat.
const threshold = Number(values.threshold);
if (!Number.isFinite(threshold)) {
  console.error(`--threshold must be a number, got ${JSON.stringify(values.threshold)}`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 2. @dataclass -> a type plus an object literal
//
// What you lose: a constructor, a readable repr, value equality, and the
// keyword-argument call that makes a 6-field record readable.
// What you gain: any object of the right shape fits, including one that just
// came out of JSON.parse, with no conversion step.
// ---------------------------------------------------------------------------

type Score = {
  question: string;
  correctness: number;
  latencyMs: number;
};

const SCORES: Score[] = [
  { question: "What is on order A-1001?", correctness: 1.0, latencyMs: 820 },
  { question: "Is A-1005 still coming?", correctness: 0.5, latencyMs: 1310 },
  { question: "How many orders are pending?", correctness: 1.0, latencyMs: 640 },
  { question: "What did Rivera spend in total?", correctness: 0.0, latencyMs: 2450 },
  { question: "When did A-1004 arrive?", correctness: 1.0, latencyMs: 710 },
  { question: "Which orders were cancelled?", correctness: 0.75, latencyMs: 980 },
  { question: "What is the largest order?", correctness: 1.0, latencyMs: 760 },
  { question: "Has A-1007 shipped?", correctness: 0.5, latencyMs: 1120 },
];

// ---------------------------------------------------------------------------
// 3. statistics -> thirteen lines
//
// `statistics.mean`, `statistics.median` and `statistics.quantiles` have no Node
// equivalent, in the standard library or in any obvious package. This is the
// real gap, and this is its full size.
// ---------------------------------------------------------------------------

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

const median = (xs: number[]): number => {
  const sorted = [...xs].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
};

/** Nearest-rank percentile, which is what you want for a latency budget. */
const percentile = (xs: number[], p: number): number => {
  const sorted = [...xs].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1] ?? 0;
};

// ---------------------------------------------------------------------------
// 4. collections.Counter -> a Map
// ---------------------------------------------------------------------------

const buckets = new Map<string, number>();
for (const score of SCORES) {
  const bucket = score.correctness === 1 ? "correct" : score.correctness === 0 ? "wrong" : "partial";
  buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
}

// ---------------------------------------------------------------------------

console.log(heading("An eval report, with the standard library it needed"));

const correctness = SCORES.map((s) => s.correctness);
const latencies = SCORES.map((s) => s.latencyMs);
const passed = mean(correctness) >= threshold;

if (values.format === "json") {
  // JSON.stringify is the one place Node is unambiguously nicer than Python's
  // json.dumps, because there is no serialization step for plain objects.
  console.log(
    JSON.stringify(
      {
        n: SCORES.length,
        meanCorrectness: Number(mean(correctness).toFixed(3)),
        medianLatencyMs: median(latencies),
        p95LatencyMs: percentile(latencies, 95),
        threshold,
        passed,
      },
      null,
      2,
    ),
  );
} else {
  console.log(
    "\n" +
      table(
        [{ header: "metric" }, { header: "value", align: "right" }],
        [
          ["cases", String(SCORES.length)],
          // Python: f"{x:.3f}"      JavaScript: x.toFixed(3)
          ["mean correctness", mean(correctness).toFixed(3)],
          ["median latency", `${median(latencies)} ms`],
          ["p95 latency", `${percentile(latencies, 95)} ms`],
          // Python: f"{x:,}"        JavaScript: toLocaleString, or Intl
          ["total tokens", (128_400).toLocaleString("en-US")],
          // Python: needs babel or manual formatting for currency
          ["run cost", new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 4 }).format(0.0412)],
          ...[...buckets].map(([name, n]) => [`  ${name}`, String(n)]),
        ],
      ),
  );
  console.log(
    `\n  gate at ${threshold.toFixed(2)}: ${passed ? green("PASS") : red("FAIL")}` +
      dim("   (try --threshold 0.9, or --format json)"),
  );
}

// ---------------------------------------------------------------------------

console.log(heading("The gap, counted"));

console.log(
  "\n" +
    table(
      [{ header: "Python standard library" }, { header: "In Node" }, { header: "cost" }],
      [
        ["statistics.mean / median / quantiles", "write them", "13 lines"],
        ["argparse", "node:util parseArgs", "in the box, much smaller"],
        ["@dataclass", "type + object literal", "0 lines, fewer features"],
        ["collections.Counter", "a Map", "3 lines"],
        ['f"{x:.3f}" / f"{x:,}"', "toFixed / toLocaleString / Intl", "same length"],
        ["pathlib / os.path", "node:path", "equivalent"],
        ["json", "JSON, built into the language", "shorter"],
        ["wave, audioop, struct", "nothing", green("a real hole")],
        ["pytest (a dependency)", "node:test (built in)", green("Node wins")],
      ],
    ),
);

console.log(`
  ${bold("Two rows deserve more than a table cell.")}

  ${yellow("wave, audioop, struct")} is the honest hole. Python ships binary and audio
  handling in the box; Node has ${cyan("Buffer")} and ${cyan("DataView")} and expects you to know
  the file format. If you are porting something that reads WAV headers, budget
  for it or take a dependency.

  ${green("node:test")} is the row that goes the other way, and it surprises people.
  Node ships a test runner, an assertion library and a coverage reporter, and
  ${cyan("node --test")} runs your ${cyan("*.test.ts")} files with no install, no config file, and no
  plugin to make it understand your module system. pytest is better than it, and
  pytest is not in Python's standard library.

  Add it up and the "missing batteries" story is mostly one afternoon of small
  helpers, plus one genuine gap in binary formats. It is not the reason to pick
  one language over the other, and it is worth saying because it is the first
  objection people raise.`);
