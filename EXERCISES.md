# Exercises: make the learning stick

Reading code teaches you less than *predicting* what it will do and then checking.
This file turns each section of the [README](README.md) into a few quick
active-recall prompts.

How to use it: work the section first, then come back. **Commit to an answer
before you run or reveal.** The prediction is where the learning happens. Answers
are hidden behind ▸ toggles.

> Everything here runs on `PROVIDER=mock` except Section 6, which needs a real
> model and says so, and Section 14, which needs network access but no key.

---

## Section 2: Types are erased **(offline)**

**Predict, then run.** `examples/01_types_are_erased.ts` parses
`{"merchant":"Kaffee & Co","total":"12.40"}` with `JSON.parse(reply) as Receipt`,
where `total` is declared `number`. What does `receipt.total * 0.21` print?

<details><summary>▸ Answer</summary>

`2.604`. The arithmetically **correct** VAT on 12.40.

If you predicted `NaN`, you are in good company: so did the first draft of the
example, and its output contradicted its own prose on the first run (see
[LESSONS.md](LESSONS.md) entry 1). JavaScript coerces a numeric string for `*`.
That is what makes this bug survive: the first place you use the value, it works.
</details>

**Recall.** Same bad value, four operations. Which one throws?

<details><summary>▸ Answer</summary>

Only `receipt.total.toFixed(2)`, and it throws last, in whatever function
happens to format the number. The other three: `* 0.21` is correct, `+ 2.50`
silently concatenates to `"12.402.5"`, and a `reduce` over three of them produces
`"012.4012.4012.40"`.

One bad value, four behaviors, and the loud one arrives after the quiet ones have
already written to your database.
</details>

**Do.** Change `total` in the example's `MODEL_REPLY` to `"twelve"` and rerun.
Which of the four lines changes behavior, and which does not?

<details><summary>▸ Answer</summary>

`* 0.21` becomes `NaN` (no numeric coercion available), `+ 2.50` still
concatenates, `reduce` still concatenates, `toFixed` still throws.

Worth noticing: the *only* line that got safer is the one that was silently
correct before. A non-numeric string is the easy case. A numeric string is the
dangerous one.
</details>

---

## Section 3: The call itself

**Recall.** What is the TypeScript equivalent of `asyncio.run(main())` at the
bottom of a Python script?

<details><summary>▸ Answer</summary>

Nothing. There is no equivalent and none is needed. In an ES module you can
`await` at the top level of the file; the module system handles it. `examples/02`
has no `main()` and no entry-point guard.

The one thing to know: this is an ESM feature. In CommonJS (a `.cjs` file, or a
package without `"type": "module"`) top-level await does not exist and you need
the async IIFE wrapper you may have seen in older code.
</details>

**Predict.** Both providers are hidden behind one `chat()`. Name two places the
two SDKs genuinely disagree, that the shim has to paper over.

<details><summary>▸ Answer</summary>

Any two of: where the system prompt goes (OpenAI a message with `role: "system"`,
Anthropic a top-level `system` field); what a reply is (OpenAI
`choices[0].message.content`, a string or null; Anthropic a list of typed content
blocks); and how tool arguments arrive (OpenAI a JSON **string** you parse
yourself, Anthropic an object).

None of that is TypeScript's doing. You pay the same normalization tax in Python.
</details>

---

## Section 4: Async by default **(offline)**

**Predict, then run.** Six calls against a mock with a 40ms round trip. Estimate
the wall clock for sequential, `Promise.all`, and a limit of 2.

<details><summary>▸ Answer</summary>

About 240ms, about 40ms, about 120ms. The measured run: 248ms, 42ms, 124ms.

The point is not the speedup. It is that the fast version is what you get by
default, because the language has no blocking call to offer.
</details>

**Predict.** What does `collected.length` print immediately after this?

```ts
questions.forEach(async (q) => { collected.push(await ask(q)); });
console.log(collected.length);
```

<details><summary>▸ Answer</summary>

`0`.

`forEach` predates promises. It calls your function, receives a Promise, and
discards it. The loop "completes" instantly with nothing done, and any error
inside becomes an unhandled rejection with no stack trace pointing at this line.
There is no compile error, because the callback is allowed to return anything.

200ms later the abandoned promises have finished and the array has six entries.
They ran. Nobody was waiting.
</details>

**Recall.** You batch fifty model calls with `Promise.all` and one returns a 503.
How many answers do you keep?

<details><summary>▸ Answer</summary>

Zero. `Promise.all` rejects the moment any promise rejects, and the
forty-nine successful answers are discarded with it.

`Promise.allSettled` keeps them all and tells you which failed. For model calls,
where one 503 in fifty is normal, that is almost always what you meant. Python's
`asyncio.gather` spells the same fork `return_exceptions=True`.
</details>

---

## Section 5: Parse, do not assume **(offline)**

**Recall.** Why is `ParseResult<T>` a union of `{ ok: true, value: T }` and
`{ ok: false, error: string }` rather than a function that returns `T` and throws?

<details><summary>▸ Answer</summary>

Because you cannot reach `.value` without narrowing on `.ok`, and the compiler
enforces it. Forgetting the check is not a discipline problem, it is a build
failure:

```
error TS2339: Property 'value' does not exist on type 'ParseResult<...>'.
  Property 'value' does not exist on type '{ ok: false; error: string }'.
```

That is the difference between a validator and a parser. A validator returns a
boolean and leaves the unchecked value sitting there, still usable, still the
wrong type.
</details>

**Predict.** A model returns your three expected fields plus `"confidence": 0.93`,
which you never asked for. Does `Receipt.safeParse` accept it? What happens to the
extra field?

<details><summary>▸ Answer</summary>

It accepts, and silently drops `confidence`. Zod strips unknown keys by default.

`.strict()` turns the unexpected key into an error instead. Neither is wrong. The
mistake is not knowing which one you picked, because one of them is quietly
throwing away data a model went to the trouble of producing.
</details>

**Do.** Change `total: z.number()` to `total: z.coerce.number()` in
`examples/04` and rerun. Which of the five replies changes verdict, and what have
you given up?

<details><summary>▸ Answer</summary>

Only "number as a string" flips from rejected to accepted, with `total = 12.4`.
`"about twelve"` is still rejected, so coercion is not a blanket surrender.

What you gave up is the signal. The day your prompt starts returning strings for
every number, a coercing schema will never tell you. Rule of thumb: coerce at the
edges you do not control, stay strict on the ones you do, and keep the eval that
would notice the drift.
</details>

---

## Section 6: Structured output **(needs a real model)**

**Predict, then run.** The example adds a required `vatNumber: z.string()` to the
schema and feeds it a receipt with no VAT number on it. What comes back?

<details><summary>▸ Answer</summary>

Not a hallucinated VAT number, which is what the example originally predicted.
Measured:

| model | value |
|---|---|
| `gpt-5.4-nano` | `""` |
| `claude-haiku-4-5` | `"<UNKNOWN>"` |

Both dodged rather than fabricated. The problem is subtler than hallucination:
each model invented its own private encoding for "absent," nothing documents it,
nothing stops it changing next version, and `z.string()` accepts all of them. The
string `"<UNKNOWN>"` is now in your database, in a column your finance export
reads.
</details>

**Recall.** You have a provider-enforced schema. Why still run `safeParse` on the
reply?

<details><summary>▸ Answer</summary>

Because the provider's guarantee is about transport, not about your program. The
schema you sent could be stale, the SDK could be a version behind, a future model
could regress, and on Anthropic the "enforcement" is a forced tool call rather
than a JSON mode. The parse costs microseconds and turns a class of production
incident into a log line.
</details>

**Do.** Design the schema for extracting a support ticket's `priority` from free
text, where the source often does not state one. What is wrong with
`z.enum(["low", "medium", "high"])`?

<details><summary>▸ Answer</summary>

It forces a guess. Every required field is a question the model is forbidden to
duck, so a ticket with no stated priority gets one invented, and you cannot tell
those apart from the real ones afterwards.

Add the honest option: `z.enum(["low", "medium", "high", "unstated"])`, or make it
`.nullable()`. Then "I do not know" is in the contract, your code can branch on
it, and your types force you to handle it.
</details>

---

## Section 7: Blocks and unions **(offline)**

**Recall.** What does this line do, and why is it at the bottom of a `switch`?

```ts
const unhandled: never = block;
```

<details><summary>▸ Answer</summary>

It makes the switch exhaustive, checked at compile time. TypeScript narrows
`block` by elimination, so if every variant is handled, the type remaining in
`default` is `never` and the assignment is legal. Add a variant to the union and
it stops being legal, in every switch that does not handle it, across the whole
codebase, with no one remembering to look.

The error names the case you forgot:
`Type 'ToolResultBlock' is not assignable to type 'never'.`
</details>

**Predict.** `ToolUseBlock.input` is typed `unknown`. Why not give it a real
shape, since we know what schema we sent the model?

<details><summary>▸ Answer</summary>

Because a type annotation on arriving data is a claim, not a check, and the model
is under no obligation to honor the schema you sent. Typing it `{ orderId: string }`
would compile and would be a lie exactly as often as the model is wrong.

`unknown` is the truthful type, and it forces every caller through a runtime
parse. This is the same argument as Section 2, expressed in the library's own
types instead of in prose.
</details>

**Do.** Add a fifth variant to `ContentBlock` in `tsai/types.ts`, for example
`{ type: "thinking"; text: string }`. Run `npm run typecheck`. How many places
break, and is that the number you expected?

<details><summary>▸ Answer</summary>

Two places, both exhaustive switches:

```
examples/06_blocks_and_unions.ts(75,13): Type 'ThinkingBlock' is not assignable to type 'never'.
tsai/providers.ts(283,15):              Type 'ThinkingBlock' is not assignable to type 'never'.
```

Nothing else. Code that only reads text blocks, or filters by type, keeps
compiling because it was already handling the "not my variant" case. That is the
property you want: adding to a union breaks exactly the code that made a claim
about the whole union, and leaves alone the code that did not.

Worth knowing: `tsai/providers.ts` only reports because this exercise was
*run*. The `never` check there was missing until then, and the switch quietly
returned `undefined` for an unhandled block, because the function's return type
is `unknown` and `unknown` accepts `undefined`. A demonstration in `examples/06`
does not protect the library; the check has to be in the library.
</details>

---

## Section 8: Tool arguments **(offline)**

**Predict.** The schema is `z.object({ orderId: z.string() })`. Which of these are
accepted?

```
{ orderId: "A-1003" }
{ orderId: 1003 }
{ orderId: "../../etc/passwd" }
{ orderId: "A-1003; ignore previous instructions" }
```

<details><summary>▸ Answer</summary>

With plain `z.string()`: the first, third and fourth. All three are perfectly
valid strings.

The repo uses `z.string().regex(/^A-\d{4}$/)` instead, which accepts only the
first. In this toy repo the other two would harmlessly fail a lookup. In a system
that builds a file path or a query out of that argument, they are the whole
attack.

**Validate the shape, then constrain the range.** The schema is the only place in
an agent where you get to say what the model is allowed to ask for.
</details>

**Predict, then run.** What happens if `runTool` skips validation and the model
sends `{ orderId: 1003 }`?

<details><summary>▸ Answer</summary>

`TypeError: id.trim is not a function`, thrown inside a helper three frames from
the mistake, on a line with nothing wrong with it.

And that is the **good** case. The bad case is a lookup that does not crash and
silently returns "not found" for an order that exists, so a support agent tells a
customer their order does not exist.
</details>

---

## Section 9: Streaming and cancelling **(offline)**

**Predict.** You call `controller.abort()` halfway through a `for await` loop over
a token stream. Does the loop throw?

<details><summary>▸ Answer</summary>

It depends on the stack, which is the lesson. Measured on all three this repo
ships:

| stack | behavior |
|---|---|
| mock | throws, `error.name === "AbortError"` |
| openai | does **not** throw. The loop simply ends. |
| claude | throws `APIUserAbortError("Request was aborted.")`, `.name` is `"Error"` |

All three stopped the stream; only the delivery differed. So
`catch (e) { if (e.name === "AbortError") ... }` is wrong on two of the three:
one never throws, the other's name is the generic `"Error"`.

You need both halves: a `try/catch` **and** a `signal.aborted` check after the
loop.
</details>

**Recall.** Why does checking `signal.aborted` after the loop matter even when you
did catch the error?

<details><summary>▸ Answer</summary>

Because on the stack that does not throw, a cancelled generation looks exactly
like a completed one. Without the check you cache it, show it, or feed it to the
next step as if the model had finished talking.
</details>

**Recall.** Why can a streaming endpoint not run the same output guardrail a
non-streaming one can?

<details><summary>▸ Answer</summary>

Because the answer is on the user's screen before the last token exists. A guard
can only redact what it has not yet printed.

The options are all trades: buffer, check, then release (giving up most of the
latency win), or stream and accept that a retraction is sometimes visible. There
is no version where you get both.
</details>

---

## Section 10: Errors and retries **(offline)**

**Predict.** Under `strict`, what is the type of `error` here?

```ts
try { await chat(...) } catch (error) { ... }
```

<details><summary>▸ Answer</summary>

`unknown`. Not `Error`, not `any`.

The compiler is being accurate rather than difficult: `throw "nope"` is legal
JavaScript, `throw { code: 42 }` is legal, and a rejected promise can carry any
value. Python's `except Exception as e` can promise you an exception object
because Python only lets you raise those.
</details>

**Predict, then run.** What does this print, and what is the exit code?

```bash
node -e 'Promise.reject(new Error("boom")); setTimeout(() => console.log("alive"), 100)'
```

<details><summary>▸ Answer</summary>

It prints the error and a stack trace and exits **1**. `alive` never runs.

Since Node 15 an unhandled rejection terminates the process. One forgotten
`await` in a background task, on a path that only fails when a provider is having
a bad afternoon, takes down a server that was otherwise healthy. Python's
equivalent prints "coroutine was never awaited" and carries on.

The only reliable defense is a lint rule, because it is a mistake of omission and
there is nothing on the page to review:
`@typescript-eslint/no-floating-promises`.
</details>

**Recall.** Both SDKs retry automatically. Name a failure their retry does not
cover.

<details><summary>▸ Answer</summary>

A stream that dies after the first token; a tool result that failed validation; a
response that arrived fine and was semantically useless; anything where "retry"
means re-running your wrapper rather than re-issuing one HTTP request. Once your
call is wrapped in anything, the retry belongs at your layer.
</details>

---

## Section 11: The standard-library gap **(offline)**

**Recall.** Which Python standard-library modules have no reasonable Node
equivalent at all?

<details><summary>▸ Answer</summary>

The binary and audio ones: `wave`, `audioop`, `struct`. Node has `Buffer` and
`DataView` and expects you to know the file format yourself.

Almost everything else is either present (`node:path`, `JSON`, `node:util`
`parseArgs`), or is a handful of lines you write once (`statistics` is 13 lines;
`collections.Counter` is a `Map`).
</details>

**Predict.** Which of these is in Node's standard library: a test runner, an
argument parser, a `.env` loader, a coverage reporter?

<details><summary>▸ Answer</summary>

All four. `node --test`, `node:util` `parseArgs`, `process.loadEnvFile`, and
`node --test --experimental-test-coverage`.

This is the row that surprises Python people, because pytest is better than
`node:test` and pytest is not in Python's standard library. `npm test` in this
repo runs seven `.test.ts` files with no install, no config file, and no plugin
to teach the runner about TypeScript or ES modules.
</details>

---

## Section 12: Tokens and bytes **(offline; one part needs a key)**

**Predict.** `gpt-tokenizer` counts a prompt at 26 tokens. The API reports 32
prompt tokens for the same text. Which is wrong?

<details><summary>▸ Answer</summary>

Neither. A chat request is not a bare string: the role, the message boundaries
and the conversation scaffolding are tokens too, and that overhead is per
message.

Use the local count to decide what to send. Use `usage` to decide what it cost.
</details>

**Recall.** You want to enforce a token budget before sending. What is different
about doing that on Claude?

<details><summary>▸ Answer</summary>

There is no public Anthropic tokenizer to run locally. `gpt-tokenizer` implements
OpenAI's vocabularies and nothing else, so on Claude you call the `count_tokens`
endpoint, which is an API round trip.

If your cost controls depend on knowing the size before you send, that asymmetry
is worth designing around rather than discovering.
</details>

---

## Section 13: One process, one loop **(offline)**

**Predict, then run.** A handler does 600ms of synchronous work. What does a
concurrent `/health` request measure?

<details><summary>▸ Answer</summary>

About 592ms, when measured from another process. Not slowed: stopped. The event
loop had no opportunity to serve it.

Compare the streaming route in the same table: 22ms, indistinguishable from idle,
because a handler that `await`s is off the loop entirely while it waits. That
contrast is the whole shape of Node.
</details>

**Predict.** The first version of that example measured `/health` from inside the
same script and reported 2ms. Why?

<details><summary>▸ Answer</summary>

Because the measuring code was on the blocked loop too. Its `setTimeout(..., 20)`
could not fire until the busy loop finished, so the health check went out *after*
the stall was over and correctly measured nothing.

The general form is the operational lesson: **a stalled Node process cannot
report that it is stalled.** Your health endpoint, your request timeouts, your
metrics flush and your SIGTERM handler are all on the loop that is not running.
It looks fine until something outside it notices.
</details>

**Recall.** How is this different from Python's GIL?

<details><summary>▸ Answer</summary>

The GIL is one lock in one process, and a typical deployment runs several uvicorn
workers, so a blocking handler occupies one worker and the others keep serving.
Node has one thread per process, so a blocking handler occupies the entire
process.

The Node answers are the same shape as the Python one, just explicit:
`worker_threads` to move CPU work off the loop, or `cluster` and more containers
to have more loops.
</details>

---

## Section 14: The ecosystem **(needs network, no key)**

**Predict, then run.** Of nine jobs an AI engineer has, how many have a
maintained TypeScript package?

<details><summary>▸ Answer</summary>

Eight of nine on the run in the README, with a caveat on one: schema validation,
tokenizing, RAG, agent graphs, tracing, evals and provider abstraction all have
real packages, several of them first-party. Structured extraction has
`@instructor-ai/instructor`, last published over a year ago.

The missing one is training. PyTorch, PEFT, TRL and MLX are Python down to the
CUDA bindings and no TypeScript equivalent is coming.
</details>

**Recall.** Why does the example deliberately not show PyPI download counts next
to npm ones?

<details><summary>▸ Answer</summary>

Because they are not the same unit. npm counts include every CI run and every
transitive install; PyPI's do not. Side by side they would look rigorous and
argue nothing, which is exactly the kind of chart this series exists to avoid.

The npm column stays because comparing `zod` to `@instructor-ai/instructor`
*within* one registry is meaningful. And there is a second reason in the file:
pypistats returns 429 for a burst of nine lookups, which the example found out by
doing it.
</details>

---

## The capstone: `ask.ts`

**Predict.** The capstone runs tool rounds unstreamed and streams only the final
answer. Why not stream the whole thing?

<details><summary>▸ Answer</summary>

Because you cannot act on half a tool call. Tool arguments arrive as JSON
fragments and mean nothing until the last one lands, so there is no version where
you start running a tool early. On OpenAI you reassemble those fragments per
tool-call index yourself; Anthropic's SDK does it for you behind
`finalMessage()`.

That is the honest structure of the problem, not a workaround.
</details>

**Recall.** The final streamed call passes a *different* system prompt. What goes
wrong without it?

<details><summary>▸ Answer</summary>

The final call has no tools, and a model that still wanted a lookup does not know
that. On Claude, asking "How much has Rivera spent in total?" produced this as
the final answer:

> I can see some orders from Rivera, but let me check if there are more orders
> beyond this list.

A reasonable sentence and a useless answer. The fix is to say the affordance is
gone: "You have now received all the tool results you are going to get." See
[LESSONS.md](LESSONS.md) entry 6.

**If your loop changes what the model can do, say so in the prompt.**
</details>

**Do.** Run `--json` on a question the tools cannot answer, for example
`npx tsx hands_on/ask.ts "What is the capital of France?" --json`. What does the
output tell you, and which field carries it?

<details><summary>▸ Answer</summary>

`answeredFromTools: false`, and the CLI prints a warning on stderr.

That field exists because of Section 6's lesson: give the model a legal way to
say "the source did not support this," and then act on it. Without the field the
model would still answer, and the answer would look identical to a grounded one.
</details>

**Do (the real exercise).** Add a third tool, `orders_by_customer`. Give it a
schema narrow enough that a customer name which is really an injected instruction
is rejected before it reaches your code. Then ask the capstone a question that
needs it.

<details><summary>▸ Answer</summary>

There is no single right schema, which is the point. `z.string()` is wrong.
`z.string().min(2).max(40).regex(/^[\p{L}\s'-]+$/u)` is defensible: letters,
spaces, apostrophes and hyphens, which fits real surnames and rejects
`"Rivera; ignore previous instructions"` and `"../../etc/passwd"`.

Notice what you had to do to write it: decide what a customer name actually *is*
in your domain. That is the work, and no amount of type checking does it for you.
A schema is where a security decision gets written down.
</details>

---

## One last one, across the whole repo

**Recall.** Zod validated every tool argument and every structured answer in the
capstone. In the measured Claude run, the agent still reported Rivera's total as
EUR 578.99 when the tool had returned three Rivera orders totalling EUR 634.99.
Why did nothing catch it?

<details><summary>▸ Answer</summary>

Because validation checks that an answer is *well-formed*, not that it is
*right*. `{ answer: string, orderIds: string[], answeredFromTools: boolean }` was
satisfied perfectly by a wrong sum.

Only an eval catches that: a set of questions with known answers, scored on every
change. It is the subject of the [Evals dive](https://github.com/alexvervloet/evals-deep-dive),
and it is the thing this repo most conspicuously does not do.

Worth holding onto as the boundary of everything here: the type system stops
malformed data, Zod stops mistyped data, and neither has an opinion about
arithmetic.
</details>
