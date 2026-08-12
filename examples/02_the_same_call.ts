/**
 * Example 02: the call itself, which is the part that did not change.
 *
 * Before cataloguing differences, it is worth seeing how little there is to
 * catalogue at the API level. You send a list of messages. You get back a
 * message. Both official SDKs are maintained alongside their Python siblings,
 * with the same method names and the same request fields.
 *
 * Two things are genuinely new, and both are visible in this file:
 *
 *   1. `await`. Every call returns a Promise, because Node has no synchronous
 *      network I/O to offer. In Python you opt into `async`; here it is the
 *      only option. Example 03 shows what that buys you.
 *
 *   2. Top-level `await`. There is no `asyncio.run(main())` and no
 *      `if __name__ == "__main__"`. In an ES module you can await at the top
 *      level of the file, because the module system was built to handle it.
 *
 * Runs on the offline mock by default, so this costs nothing:
 *
 *     npx tsx examples/02_the_same_call.ts
 *
 * For a real model:
 *
 *     PROVIDER=openai secrun npx tsx examples/02_the_same_call.ts
 *     PROVIDER=claude secrun npx tsx examples/02_the_same_call.ts
 */

import { bold, count, cyan, dim, heading, ms } from "../tsai/fmt.ts";
import { chat, describe } from "../tsai/providers.ts";

console.log(`Provider: ${describe()}`);

console.log(heading("The call"));
console.log(`
    ${dim("const reply = await chat({")}
    ${dim("  system: \"You are concise.\",")}
    ${dim("  messages: [{ role: \"user\", content: \"...\" }],")}
    ${dim("});")}

  Underneath, on PROVIDER=openai, that is:

    ${dim("await client.chat.completions.create({ model, messages })")}

  which is the Python line with an ${cyan("await")} in front of it.`);

// No main(), no asyncio.run, no event loop to start. Top-level await in an ES
// module. The file is the async function.
const reply = await chat({
  system: "You are concise. Answer in one sentence.",
  messages: [{ role: "user", content: "In one sentence, what does `await` do?" }],
});

console.log(heading("The reply"));
console.log(`\n  ${reply.text}\n`);
console.log(
  dim(
    `  model=${reply.model}  ` +
      `tokens=${count(reply.usage.promptTokens)} in / ${count(reply.usage.completionTokens)} out  ` +
      `latency=${ms(reply.latencyMs)}  stop=${reply.stopReason}`,
  ),
);

console.log(heading("What we normalized, and why you should look"));
console.log(`
  The ${cyan("reply")} above is this repo's own shape, not either SDK's. Both
  providers were flattened into { text, blocks, model, usage, stopReason }, which
  is the same thing the Python dives do in their providers.py.

  The flattening is not free, and tsai/providers.ts is worth reading for exactly
  the places it is awkward:

    ${bold("where the system prompt goes")}  OpenAI: a message with role "system".
                                 Anthropic: a top-level \`system\` field.
    ${bold("what a reply is")}               OpenAI: choices[0].message.content, a
                                 string or null. Anthropic: a list of typed
                                 content blocks. Example 06 is about that list.
    ${bold("tool arguments")}                OpenAI hands you a JSON *string* to
                                 parse. Anthropic hands you an object. Both are
                                 \`unknown\` as far as your program should care.

  None of that is TypeScript's doing. It is the same normalization tax you pay in
  any language, and it is the reason a one-file provider shim is the first thing
  worth writing in a real project.`);
