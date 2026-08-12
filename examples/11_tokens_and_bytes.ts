/**
 * Example 11: counting tokens and moving bytes (offline; one optional call).
 *
 * Two chores that every LLM codebase needs and that look different here:
 *
 *   Tokens. Python has `tiktoken`, a Rust extension maintained by OpenAI. Node
 *   has `gpt-tokenizer` and `js-tiktoken`, both pure-JavaScript ports. They give
 *   the same numbers for OpenAI models. They are slower, which matters if you
 *   are counting a corpus and not a prompt.
 *
 *   Bytes. Python has `bytes`, `open(path, "rb")`, `base64`, and `struct` for
 *   picking fields out of a binary header. Node has `Buffer`, which does the
 *   first three more conveniently and the fourth not at all.
 *
 * With a key on the environment, section 2 checks the local token count against
 * what the provider actually billed, which is the only way to know whether a
 * port is telling you the truth.
 *
 *     npx tsx examples/11_tokens_and_bytes.ts
 *     PROVIDER=openai secrun npx tsx examples/11_tokens_and_bytes.ts
 */

import { readFileSync } from "node:fs";
import { decode, encode } from "gpt-tokenizer";
import { bold, count, cyan, dim, green, heading, red, table, yellow } from "../tsai/fmt.ts";
import { fromRoot } from "../tsai/env.ts";
import { chat, providerName } from "../tsai/providers.ts";

// ---------------------------------------------------------------------------

console.log(heading("1. Tokens are not words, and not characters"));

const SAMPLES = [
  "Hello world",
  "hello world",
  " hello world",
  "antidisestablishmentarianism",
  "A-1003",
  "こんにちは世界",
  '{"merchant":"Kaffee & Co","total":7}',
];

console.log(
  "\n" +
    table(
      [
        { header: "text" },
        { header: "chars", align: "right" },
        { header: "tokens", align: "right" },
        { header: "pieces" },
      ],
      SAMPLES.map((text) => {
        const ids = encode(text);
        return [
          JSON.stringify(text),
          String(text.length),
          String(ids.length),
          // Decoding each id on its own shows where the splits fell.
          ids.length <= 10 ? dim(ids.map((id) => decodeOne(id)).join("|")) : dim("..."),
        ];
      }),
    ),
);

/** Decode a single token id back to its text, so the splits are visible. */
function decodeOne(id: number): string {
  return decode([id]);
}

console.log(`
  The rows worth noticing: capitalization changes the count, a leading space
  changes the count, and a long English word costs more than a short Japanese
  sentence. None of that is TypeScript's doing. It is the same tokenizer the
  Python dives use, reimplemented, and it is why "roughly four characters per
  token" is a rule of thumb and not a budget.

  ${dim("(The Japanese row is visibly misaligned. tsai/fmt.ts pads by counting")}
  ${dim("string length, and those characters occupy two terminal columns each.")}
  ${dim("Python's str.ljust has exactly the same bug; rich is what fixes it.)")}`);

// ---------------------------------------------------------------------------

console.log(heading("2. Is the port telling the truth?"));

const PROMPT =
  "Summarize the following in one sentence: a mechanical keyboard was ordered " +
  "on the fourteenth of June and has not shipped yet.";

const localCount = encode(PROMPT).length;
console.log(`\n  gpt-tokenizer says the prompt is ${bold(String(localCount))} tokens.`);

if (providerName() === "openai") {
  // The only authoritative number is the one on the response.
  const reply = await chat({
    messages: [{ role: "user", content: PROMPT }],
    maxTokens: 32,
  });
  const billed = reply.usage.promptTokens;
  const overhead = billed - localCount;
  console.log(`  the provider billed ${bold(String(billed))} prompt tokens.`);
  console.log(`
  The difference is ${bold(String(overhead))} tokens, and it is not an error in the tokenizer.
  A chat request is not a bare string: the role, the message boundaries and the
  conversation scaffolding are all tokens too. That fixed overhead per message is
  why a local count is a good ${cyan("estimate")} and a bad ${cyan("invoice")}.

  ${green("Use the local count to decide what to send. Use usage to decide what it cost.")}`);
} else if (providerName() === "claude") {
  console.log(`
  ${yellow("Skipping the comparison on PROVIDER=claude.")} There is no public Anthropic
  tokenizer to compare against: ${cyan("gpt-tokenizer")} implements OpenAI's vocabularies
  and nothing else. For Claude you call the ${cyan("count_tokens")} endpoint, which is an
  API round trip, so budgeting before you send costs you a request.

  That asymmetry is worth designing around. If your cost controls depend on
  knowing the size before you send, an OpenAI-family model lets you compute it
  locally and Claude does not.`);
} else {
  console.log(`
  ${dim("Run with a real provider to compare this against what you were billed:")}
  ${dim("  PROVIDER=openai secrun npx tsx examples/11_tokens_and_bytes.ts")}`);
}

// ---------------------------------------------------------------------------

console.log(heading("3. Bytes: Buffer instead of bytes"));

const packageJson = readFileSync(fromRoot("package.json"));
console.log(`
    ${dim('readFileSync(path)')}                    -> ${cyan("Buffer")}, ${count(packageJson.length)} bytes
    ${dim('readFileSync(path, "utf8")')}            -> ${cyan("string")}
    ${dim('buffer.toString("base64")')}             -> ${dim(packageJson.toString("base64").slice(0, 32))}...
    ${dim('Buffer.from(b64, "base64")')}            -> back to bytes, ${
      Buffer.from(packageJson.toString("base64"), "base64").equals(packageJson)
        ? green("round trip verified")
        : red("mismatch")
    }

  This is one of the places Node is simply more convenient. Python needs
  ${dim("base64.standard_b64encode(data).decode('ascii')")}, two steps because bytes and
  str are different types and base64 returns the former. ${cyan("Buffer")} is both, so it
  is one call in each direction.

  Which matters because every image you ever send a model goes through exactly
  this: bytes in, base64 out, into a content block.`);

// ---------------------------------------------------------------------------

console.log(heading("4. And the place it is worse: reading a binary header"));

// An 8x8 PNG, inlined so this example needs no asset files.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4YWODFTEMLQkAZZlQAVIPr1MAAAAASUVORK5CYII=",
  "base64",
);

/**
 * Pull the width and height out of a PNG.
 *
 * A PNG starts with an 8-byte signature, then a length-prefixed IHDR chunk whose
 * data begins with two big-endian 32-bit integers. In Python this is one line:
 *
 *     width, height = struct.unpack(">II", data[16:24])
 *
 * Node has no struct module, so you reach for a DataView and say big-endian
 * yourself. It is not hard. It is just yours now.
 */
function pngSize(data: Buffer): { width: number; height: number } {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
}

const size = pngSize(TINY_PNG);
const isPng = TINY_PNG.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

console.log(`
    signature check: ${isPng ? green("valid PNG") : red("not a PNG")}
    dimensions:      ${bold(`${size.width}x${size.height}`)}  ${dim(`(${TINY_PNG.length} bytes)`)}

  ${bold("The false-endian argument is the whole lesson.")} ${cyan("view.getUint32(16, false)")}
  means big-endian, and getting it wrong gives you a plausible number rather
  than an error: this image would read as ${count(new DataView(TINY_PNG.buffer, TINY_PNG.byteOffset, TINY_PNG.byteLength).getUint32(16, true))} pixels wide.
  Python's ${dim('">II"')} makes the same mistake harder to write and much easier to spot
  in review.

  Scale that up and it is the honest version of example 10's "a real hole": if
  you are parsing WAV headers or a binary protocol, Node will do it, and you will
  write more of it, and the bugs will be quieter.`);
