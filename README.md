# AI Engineering in TypeScript: A Guided Deep Dive

A hands-on companion to the [AI Engineering deep dive series](#the-series), for
people who build with LLMs in **TypeScript** instead of Python. Every concept is
a small, runnable script; every section ends with something to run; almost all of
it runs offline and free on a built-in mock model. No frameworks, and just enough
code to see how each piece works.

This repo is **standalone**: it teaches everything it needs on its own, and does
not assume you have done the Python dives. Where the contrast is genuinely
instructive, it says "in Python this is X" and moves on. If you have done the
Python dives, those asides are the shortest path through; if you have not, skip
them and nothing is missing.

Like its siblings, it is meant to be *walked through*.
[EXERCISES.md](EXERCISES.md) has a predict-then-run prompt for each section, and
[TEXTBOOK.md](TEXTBOOK.md) is the same material as prose if you would rather read
than run.

---

## 0. The one big idea

> **Your types stop at the network boundary. Everything a model hands back is
> `unknown` until you check it at runtime, and everything you send is a promise.**

That is the whole repo. TypeScript is genuinely good at LLM work, better than
Python in a few specific places, and the one thing that surprises people arriving
from Pydantic is that **TypeScript's types are erased before the program runs.**
`tsc` checks your code and then throws every type away. What executes is
JavaScript, and it has never heard of your interfaces.

For values you construct, that is fine: the compiler already checked them. For
values that *arrive*, it means the annotation is a claim with nothing behind it,
and the most arriving-est value in your codebase is whatever the model just said.
So the discipline this repo teaches is: parse at the boundary, narrow everything
else, and let the compiler enforce that you did.

The second half, promises, is smaller but touches every line. There is no
synchronous version of anything, which costs you an `await` on hello-world and
hands you concurrency for free.

Hold onto those two and nothing else here is complicated.

---

## 1. Setup (3 minutes)

```bash
# 1. Check your setup. This runs BEFORE npm install, on Node's own
#    type stripping, and tells you what is missing.
node --experimental-strip-types check_setup.ts

# 2. Install (four dependencies: two SDKs, Zod, a tokenizer)
npm install

# 3. Optional: pick a provider. The default needs no file and no key.
cp .env.example .env
```

You need **Node 22 or newer**. That is what gives you `process.loadEnvFile`, a
stable `fetch`, `AbortSignal.any`, and a built-in test runner, all of which this
repo uses instead of a dependency.

| `PROVIDER` | What it is | Key needed |
|------------|------------|------------|
| `mock` (default) | A deterministic, offline, in-process model. No network, no cost. | none |
| `openai` | OpenAI chat completions (`gpt-5.4-nano`) | `OPENAI_API_KEY` |
| `claude` | Anthropic messages (`claude-haiku-4-5`) | `ANTHROPIC_API_KEY` |

**Twelve of the thirteen examples need no key.** Promises, cancellation,
discriminated unions, validation, the event loop and the standard-library gap are
all visible offline, and paying for tokens to demonstrate `for await` would be
silly. Example 05 is the exception and says so.

> **Your API key does not go in `.env`.** Store it in your OS keychain and inject
> it per command with `secrun`: two-minute setup in [SECRETS.md](../docs/SECRETS.md).
> If you select a real provider and the key is missing, the repo degrades to the
> mock **loudly**, with a banner and a `FALLBACK` note on every provider line, so
> a keyless run can never be mistaken for a real one. `PROVIDER_STRICT=1` makes
> it a hard error instead, which is what you want in CI.

---

## 2. Types are erased

The foundational fact, and the reason the rest of the repo is shaped the way it
is.

```bash
npx tsx examples/01_types_are_erased.ts        # offline
```

A model returns `{"total": "12.40"}` when you asked for a number. You write
`JSON.parse(reply) as Receipt`, which compiles, and then four ordinary lines of
downstream arithmetic do four different things:

```
receipt.total * 0.21                        2.604       <- correct
receipt.total + 2.50                        "12.402.5"  <- silently concatenated
[a,b,c].reduce((s, r) => s + r.total, 0)    "012.4012.4012.40"
receipt.total.toFixed(2)                    TypeError
```

The lesson is not "it breaks." It is that JavaScript's coercion makes the first
line *right*, which is why the bug survives review and your first ten thousand
receipts, and why the one that finally throws does so in innocent reporting code
hours later. `as` is not a check. It is you telling the compiler to stop asking.

---

## 3. The call itself, which barely changed

```bash
npx tsx examples/02_the_same_call.ts                          # offline mock
PROVIDER=openai secrun npx tsx examples/02_the_same_call.ts   # real
```

Before cataloguing differences it is worth seeing how few there are at the API
level. Both official SDKs are maintained alongside their Python siblings, with
the same method names and the same request fields. `client.chat.completions.create(...)`
is the Python line with an `await` in front of it.

Two things are new, and both are in the file: every call returns a Promise, and
there is no `asyncio.run(main())`, because an ES module can `await` at the top
level. The file *is* the async function.

---

## 4. Async is not a mode you opt into

```bash
npx tsx examples/03_async_by_default.ts        # offline
```

Python makes you choose: `OpenAI()` and `AsyncOpenAI()` are different clients,
`def` and `async def` are different worlds. Node deleted the choice, and the
measurement is the point:

```
strategy     code                              wall clock
sequential   for (const q of qs) await ask(q)       248ms
all at once  await Promise.all(qs.map(ask))          42ms
at most 2    await mapLimit(qs, 2, ask)             124ms
```

The parallel version is not an optimization you added. It is what you get when
the language has no blocking call to offer.

Then the two sharp edges, both ordinary code with no compile error:
`array.forEach(async ...)` throws your promises away (the loop "finishes"
instantly with nothing done), and `Promise.all` discards five good answers when
the sixth fails, which for a batch of model calls is almost never what you meant.

---

## 5. Parse, do not assume

```bash
npx tsx examples/04_parse_dont_assume.ts       # offline
```

Five replies a model genuinely produces, through an unchecked cast and through a
Zod parse:

| model reply | `JSON.parse(...) as Receipt` | `parseModelJson(..., Receipt)` |
|---|---|---|
| clean JSON | accepted | accepted |
| wrapped in code fences | accepted | accepted |
| number as a string | accepted, `total+1 = "12.401"` | rejected: expected number, received string |
| invented an extra field | accepted | accepted, extra key dropped |
| refused, in prose | threw `SyntaxError` | rejected: not JSON at all |

The section that matters most is the return type. `parseModelJson` gives you
`{ ok: true, value: T } | { ok: false, error: string }`, so reaching `.value`
without checking `.ok` **does not compile**. You cannot write the bug where you
validate and then use the unchecked variable anyway.

It also puts real numbers on the two dials people set without noticing: Zod
strips unknown keys by default (`.strict()` if you would rather hear about them),
and `z.coerce.number()` rescues `"12.40"` while still rejecting `"about twelve"`.
Coercion is a real tool with a real cost: it keeps the pipeline running and it
guarantees you will never find out your prompt started returning strings.

---

## 6. Making the provider guarantee the shape

```bash
PROVIDER=openai secrun npx tsx examples/05_structured_output.ts
PROVIDER=claude secrun npx tsx examples/05_structured_output.ts
```

> **This is the one example that needs a real model.** Schema enforcement happens
> inside the provider, and a mock inventing a plausible answer would prove
> nothing. On `PROVIDER=mock` it prints the request shapes and stops.

One Zod schema becomes three things: the static type, the runtime validator, and
the JSON Schema the provider is given (`z.toJSONSchema`, built into Zod 4). The
two providers get there differently, which is worth knowing: OpenAI has a
first-class `response_format`, Anthropic has no equivalent and the documented
route is to define one tool and force the model to call it. Structured output
turns out to be tool use wearing a hat.

And then the part the example exists for. Add a required `vatNumber` to the
schema and hand it a receipt that does not have one:

| model | value returned |
|---|---|
| `gpt-5.4-nano` | `""` |
| `claude-haiku-4-5` | `"<UNKNOWN>"` |

Neither hallucinated a fake VAT number, which is better than this example
originally predicted. The problem is subtler and worse: **each model invents its
own private encoding for "absent", and `z.string()` accepts all of them.**
Nothing documents `"<UNKNOWN>"`; nothing stops it changing next model version.
The schema did not prevent the bad value, it guaranteed the bad value would be a
string.

The fix is in the schema, not the prompt: `z.string().nullable()` makes "I did
not find it" a legal answer, and both models then return `null`. Every required
field is a question the model is forbidden to duck.

---

## 7. Content blocks, where TypeScript wins

```bash
npx tsx examples/06_blocks_and_unions.ts       # offline
```

Most of this dive is about TypeScript being less help than you hoped. This is the
other side of the ledger.

A reply is a list of typed blocks. In Python you walk it with `isinstance` checks
or dictionary keys and nothing verifies the pairing. Here each block is a member
of a discriminated union, so `block.type === "tool_use"` narrows it, reading
`.text` off that branch is a compile error, and an exhaustive `switch` with a
`never` check breaks the build the day someone adds a variant.

The example does not claim this. It runs `tsc` on files in `broken/` that get it
wrong and prints the actual output:

```
broken/missing_case.ts(29,13): error TS2322: Type 'ToolResultBlock' is not assignable to type 'never'.
broken/wrong_field.ts(27,18): error TS2339: Property 'text' does not exist on type 'ToolUseBlock'.
```

The compiler did not say "you missed a case." It said **which** case, by name.

The honest limit is in the last section: what got checked is that your code
agrees with your declared union. Nothing checked that the provider's JSON agrees
with either. The SDKs' own response types are hand-written descriptions of an
API, shipped in a package. They are a claim. Which is why `ToolUseBlock.input` is
typed `unknown`.

---

## 8. A tool call is user input with extra steps

```bash
npx tsx examples/07_tool_args_are_untrusted.ts        # offline
```

The agent loop is four lines of control flow. The interesting part is "you run
it," because that is where a model's output stops being text and becomes
something your process does. Anything in the conversation shapes those arguments,
including a document the user uploaded.

```
a real id                accepted
wrong type               rejected: expected string, received number
missing field            rejected: expected string, received undefined
a path                   rejected: an order id looks like A-1003
an injected instruction  rejected: an order id looks like A-1003
```

The last two are why the schema is `z.string().regex(/^A-\d{4}$/)` and not
`z.string()`. Both were perfectly valid strings. In this repo they would have
harmlessly failed a lookup; in a system that builds a path or a query out of that
argument, they are the whole attack. **Validate the shape, then constrain the
range.** The schema is the only place in an agent where you get to say what the
model is allowed to ask for, and "a string" is not an answer.

The same section shows the unguarded version crashing with
`TypeError: id.trim is not a function` three frames from the mistake, which is
the *good* case. The bad case is the one that silently returns "not found" for a
real order.

---

## 9. Streaming, and stopping

```bash
npx tsx examples/08_streaming_and_cancelling.ts       # offline
```

A token stream is exactly an async iterable, so consuming one is a `for await`
loop that reads like the synchronous loop it replaced. Time to first token is the
number streaming actually improves; the total does not get shorter.

Cancellation is the half people skip and the half that matters. And this is where
the example earned its keep, because the three stacks do not agree:

| stack | on `controller.abort()` mid-stream |
|---|---|
| mock | throws, `error.name === "AbortError"` |
| openai | does not throw at all, the `for await` loop simply ends |
| claude | throws `APIUserAbortError("Request was aborted.")`, whose `.name` is `"Error"` |

All three stopped the stream. Only the delivery differed. So
`catch (e) { if (e.name === "AbortError") ... }`, which is the natural thing to
write, is wrong on two of the three. Both halves are required:

```ts
try { for await (...) } catch (e) { ... }   // it might throw
if (controller.signal.aborted) { ... }      // it might not
```

That second check is also the only thing that tells a truncated answer apart from
a complete one before you cache it or show it.

The section ends on what streaming costs: you cannot validate what you have
already shown, and half a JSON object does not parse. Both are why the capstone
streams prose and does tool rounds unstreamed.

---

## 10. Errors you did not catch, and one nobody did

```bash
npx tsx examples/09_errors_and_retries.ts      # offline
```

Three things change. Two are a fair trade and one is a hazard.

**You do not know what you caught.** Under `strict`, a caught value is `unknown`,
because `throw "nope"` is legal JavaScript. Python can promise you an exception
object; JavaScript made no such rule. So you narrow, and the example shows the
narrowing function you will write a hundred times.

**Retrying is yours.** There is no `tenacity`. Twenty lines gets you
retry-what-is-worth-retrying, exponential backoff, jitter, and a deadline. Both
SDKs retry automatically, which covers the simple case and not a stream that died
after the first token.

**And the hazard:** a rejected promise nobody awaited terminates the process.

```bash
node -e 'Promise.reject(new Error("boom")); setTimeout(() => console.log("alive"), 100)'
# prints the error, exits 1. "alive" never runs.
```

One forgotten `await` in a background task, on a path that only fails when a
provider is having a bad afternoon, takes down a healthy server. Python's
equivalent prints "coroutine was never awaited" and carries on. If you take one
configuration change from this repo into a real project, make it
`@typescript-eslint/no-floating-promises`.

---

## 11. The standard library you are missing

```bash
npx tsx examples/10_the_stdlib_gap.ts
npx tsx examples/10_the_stdlib_gap.ts --threshold 0.9 --format json
```

The most Python-flavored task in the series, an eval scorer, written with the
standard library Node actually has:

| Python standard library | In Node | cost |
|---|---|---|
| `statistics.mean` / `median` / `quantiles` | write them | 13 lines |
| `argparse` | `node:util` `parseArgs` | in the box, much smaller |
| `@dataclass` | a type plus an object literal | 0 lines, fewer features |
| `collections.Counter` | a `Map` | 3 lines |
| `f"{x:.3f}"` / `f"{x:,}"` | `toFixed` / `toLocaleString` / `Intl` | same length |
| `pathlib`, `json` | `node:path`, `JSON` | equivalent or shorter |
| `wave`, `audioop`, `struct` | nothing | **a real hole** |
| pytest (a dependency) | `node:test` (built in) | **Node wins** |

Two rows deserve more than a cell. Binary and audio formats are the honest gap:
Node has `Buffer` and `DataView` and expects you to know the file format. And
`node:test` surprises people: `node --test` runs your `*.test.ts` files with no
install and no config file. This repo's own tests (`npm test`) are seven of them.

Add it up and "missing batteries" is one afternoon of small helpers plus one
genuine hole. It is not the reason to pick a language, and it is worth measuring
because it is the first objection raised.

---

## 12. Tokens and bytes

```bash
npx tsx examples/11_tokens_and_bytes.ts
PROVIDER=openai secrun npx tsx examples/11_tokens_and_bytes.ts   # adds the check below
```

`tiktoken` becomes `gpt-tokenizer`, a pure-JavaScript port that gives the same
numbers for OpenAI models and is slower. With a key, the example checks the port
against reality: it counted 26 tokens, the provider billed 32. The six-token gap
is not a bug, it is the chat scaffolding around your string, and it is why a
local count is a good estimate and a bad invoice.

Bytes go the other way. Python needs
`base64.standard_b64encode(data).decode("ascii")`, two steps because bytes and
str are different types. `Buffer` is both, so it is one call each direction, and
every image you ever send a model goes through exactly that.

Where it is worse is reading a binary header. Python: `struct.unpack(">II", data[16:24])`.
Node: a `DataView` and you specify the endianness yourself, where getting it
wrong yields a plausible number rather than an error.

---

## 13. One process, one loop

```bash
npx tsx examples/12_one_process_one_loop.ts    # offline
```

Streaming tokens to a browser is about thirty lines of standard library:
`node:http` on the server, `fetch` on the client, `EventSource` in a browser. All
three are built in. The Python equivalent needs FastAPI and uvicorn, which are
excellent and are two dependencies and a process manager.

Then the one genuine architectural difference. Node runs your JavaScript on **one
thread**. Not one process with a lock that releases on I/O, which is what
Python's GIL does. Measured, by polling `/health` from a separate process:

| while the server is... | worst `/health` |
|---|---|
| idle | 24ms |
| streaming a model reply (awaits) | 22ms |
| running 600ms of sync code | **592ms** |

The middle row is the normal case and the reason Node suits an LLM gateway: a
handler that `await`s is off the loop entirely, so a hundred concurrent model
calls cost almost nothing but memory. The bottom row is the caveat, and it is
worse than "slow": a blocking handler occupies the *entire process*, where a
blocking handler under uvicorn occupies one worker of several.

The section after it is the one to read twice. The first version of this example
measured `/health` from inside the same process, got a healthy 2ms, and printed
it under the word "stalled." The busy loop had blocked the measuring code too:
its `setTimeout(..., 20)` fired at 401ms. **The stall is invisible from inside
the process that is stalled**, which generalizes to your health endpoint, your
timeouts, your metrics flush and your SIGTERM handler. A Node service that blocks
its loop does not look degraded until something outside it notices.

---

## 14. Measuring the ecosystem instead of arguing about it

```bash
npx tsx examples/13_ecosystem_check.ts         # needs network, no key
```

"The AI tooling is all in Python" is the objection this dive gets. It is half
true, so the example asks PyPI and npm directly, live, and reports what exists
and when it was last published.

```
job                    PyPI         published   npm                        published   npm/wk
schema + validation    pydantic     3mo ago     zod                        3mo ago     254.4M
tokenizer              tiktoken     3mo ago     gpt-tokenizer              9mo ago       1.3M
RAG framework          llama-index  2mo ago     llamaindex                 8mo ago     124.3K
agent graphs           langgraph    this month  @langchain/langgraph       this month    3.2M
tracing                langfuse     this month  langfuse                   4mo ago       1.9M
structured extraction  instructor   1mo ago     @instructor-ai/instructor  1.5y ago     22.1K
eval harness           deepeval     this month  promptfoo                  this month  630.6K
provider abstraction   litellm      this month  ai                         this month   20.6M
training / LoRA        peft         this month  none                       -                -
```

Three-part answer, and it keeps reproducing:

- **Application-layer work ports cleanly.** Validation, tokenizing, tracing,
  retrieval, agent graphs, evals: real, maintained packages, several of them
  first-party.
- **Framework-layer work is thinner.** Younger, smaller, a release behind. You
  will hit a missing feature eventually.
- **Training does not port at all.** PyTorch, PEFT, TRL and MLX are Python down
  to the CUDA bindings, and nothing is coming.

The example also explains why there is deliberately no PyPI download column, and
what happened when it tried to fetch one with `Promise.all` (a live 429, from the
same lesson section 4 just taught).

---

## The capstone: `ask.ts`

Everything above, assembled into a CLI you can use.

```bash
npx tsx hands_on/ask.ts "What is the status of order A-1003?"
npx tsx hands_on/ask.ts "Which orders are still pending?" --trace
npx tsx hands_on/ask.ts "How much has Rivera spent?" --json
npx tsx hands_on/ask.ts "List the shipped orders" --timeout 5000

PROVIDER=openai secrun npx tsx hands_on/ask.ts "Is A-1007 shipped yet?"
```

A typed agent loop over the toy orders dataset: tool arguments validated with
Zod before anything runs them, several tool calls in a round executed
concurrently, the final answer streamed, `--json` producing a provider-enforced
and then re-validated structured answer, and a single `AbortSignal` composed from
Ctrl-C and `--timeout` that cancels all of it.

Read [hands_on/ask.ts](hands_on/ask.ts); the header maps each part back to the
example that taught it. One design decision is worth understanding before you
copy it: **tool rounds are not streamed, the final answer is.** You cannot act on
half a tool call, so the loop runs unstreamed until the model stops asking for
tools, then makes one streamed call for the prose.

That final call also carries a *different system prompt*, and finding out why
cost a run. See [LESSONS.md](LESSONS.md), entry 6.

**Suggested exercise:** add a third tool (`orders_by_customer`), give it a schema
narrow enough to reject a customer name that is really an instruction, and watch
the loop pick it up with no other change.

---

## Should you write your LLM app in TypeScript?

The honest version, from what this repo measured rather than from taste.

| Reach for TypeScript when | Reach for Python when |
|---|---|
| The model call lives inside a web app you already ship in TypeScript | You are training, fine-tuning, or quantizing anything |
| You are streaming to a browser (the client story is genuinely better) | Your work is numerical, or leans on numpy/pandas/scipy |
| You want one language across API, worker and frontend | You need a framework feature only the Python version has |
| Your team's review culture already leans on the type checker | You are following along with research code |

Two things this repo would not have predicted before measuring:

**The `unknown` boundary is a feature.** It looks like friction for a week and
then it is the reason a wrong-typed field from a model becomes a log line instead
of a corrupted row. Python with Pydantic gets to the same place; the difference
is that in TypeScript you cannot quietly skip it and still read the value.

**The single event loop is the real thing to learn.** Not the syntax, not the
ecosystem. It is the one place where a habit carried over from Python produces an
outage rather than an inconvenience.

Everything else is smaller than its reputation.

---

## Where to go next

- **A real framework.** This repo hand-rolls to show the shape. In production
  people reach for the [Vercel AI SDK](https://sdk.vercel.ai) (provider
  abstraction plus streaming primitives), [LangGraph.js](https://langchain-ai.github.io/langgraphjs/)
  for stateful agent graphs, and [LlamaIndex.TS](https://ts.llamaindex.ai) for
  retrieval.
- **Evals.** Nothing in this repo checks whether an answer is *right*. Zod
  validates that it is well-formed. [promptfoo](https://promptfoo.dev) is
  Node-native and the natural next tool.
- **Edge and serverless runtimes.** Cloudflare Workers, Deno Deploy and Vercel
  functions run this code with small changes, which is a place TypeScript has no
  Python equivalent. Watch for `node:` builtins, which is mostly what changes.
- **Bun and Deno.** Both run this repo's code. Both bundle a test runner and TS
  execution without `tsx`. Node is what these examples use because it is the most
  transferable, not because it is the best of the three at this.
- **The browser half.** Streaming to `EventSource`, cancelling on unmount,
  rendering partial markdown safely. Section 13 is the server side of a story
  whose other half is where TypeScript is unmatched.
- **TypeScript 7.** The compiler is being ported to Go, with large speedups. This
  repo pins TypeScript 5 because that is what is stable; nothing here would need
  to change.

---

## From teaching code to production

The shortcuts this repo takes on purpose, and what replaces them:

| This repo's teaching shortcut | In production |
|---|---|
| `mapLimit(qs, 2, ask)` for concurrency | A rate limiter that knows your provider's actual quota, per model |
| Retries hand-rolled in one example | One shared policy, applied at the provider layer, with a budget |
| `tsai/fmt.ts` for output | Structured logs, and a tracer (Langfuse has a first-party JS SDK) |
| Tools dispatch in a `switch` | A registry, with per-tool authorization and audit logging |
| Tool results returned as strings | Typed results, size-capped, with the untrusted parts marked |
| The mock provider | A recorded-fixture layer, so tests are deterministic and free |
| `process.exit(1)` on a bad answer | A retry with the validation error fed back as a repair prompt |
| One process | Several, behind a load balancer, with event-loop-delay monitoring |
| `npm test` on seven unit tests | Those, plus an eval suite gating deploys |

The general operational machinery (observability, cost, caching, guardrails,
prompt versioning, eval gates) is built from scratch and wired into one running
app in the [Production dive](https://github.com/alexvervloet/ai-in-production-deep-dive),
in Python. The ideas port directly; sections 10 and 13 here are the parts that do
not.

---

## File map

```
check_setup.ts              <- run first; works before npm install
README.md                   <- this guide
EXERCISES.md                <- predict-then-run prompts, one per section
TEXTBOOK.md                 <- the same material as prose
LESSONS.md                  <- six things that did not go to plan, and what they taught
tsai/                       <- the from-scratch library (read it!)
  types.ts                  <- the content-block and stream-event unions
  schema.ts                 <- the Zod boundary: parse, do not assume
  providers.ts              <- the ONLY provider-specific file (mock | openai | claude)
  mock.ts                   <- the deterministic offline model
  tools.ts                  <- the two tools, and the validate-then-run gate
  orders.ts                 <- the toy dataset
  fmt.ts                    <- terminal output, the stand-in for rich
  env.ts                    <- .env via Node's built-in loadEnvFile
  compiler.ts               <- runs tsc on broken/, so "this fails" is verified
  schema.test.ts            <- npm test, on Node's built-in runner
broken/                     <- files that FAIL to compile on purpose (examples 06, 09)
examples/
  01_types_are_erased.ts          <- the one big idea            (offline)
  02_the_same_call.ts             <- the API, which barely changed
  03_async_by_default.ts          <- sequential vs parallel vs limited (offline)
  04_parse_dont_assume.ts         <- five real model replies      (offline)
  05_structured_output.ts         <- provider-enforced schemas    (NEEDS A KEY)
  06_blocks_and_unions.ts         <- where TypeScript wins        (offline)
  07_tool_args_are_untrusted.ts   <- tool args are untrusted input(offline)
  08_streaming_and_cancelling.ts  <- for await, and AbortSignal   (offline)
  09_errors_and_retries.ts        <- unknown, backoff, floating promises (offline)
  10_the_stdlib_gap.ts            <- what Python was doing for you(offline)
  11_tokens_and_bytes.ts          <- tokenizer and Buffer         (offline)
  12_one_process_one_loop.ts      <- SSE, and the event loop      (offline)
  13_ecosystem_check.ts           <- live registry comparison     (network, no key)
hands_on/
  ask.ts                    <- capstone: a typed streaming agent CLI
```

---

## Troubleshooting

Run `node --experimental-strip-types check_setup.ts` first; it catches most
problems. Then, by symptom:

| What you see | What it means / the fix |
|---|---|
| `ERR_MODULE_NOT_FOUND` on a `.ts` import | Imports need the extension, and it is `.ts` here. That is `"module": "NodeNext"` plus `allowImportingTsExtensions`, and it is what lets `tsx` and Node's own type stripping both work. |
| `Cannot determine intended module format` | A `require()` and a top-level `await` in the same file. This repo is ESM only; use `import`. |
| `PROVIDER=... is set but ... is not on the environment` | The loud mock fallback. Run under `secrun` for the real model, or `PROVIDER_STRICT=1` to make it an error. See [SECRETS.md](../docs/SECRETS.md). |
| Example 05 prints "stopping here" | Working as intended on `PROVIDER=mock`. It is the one example that needs a real model. |
| `npx tsc` installs some other package | You ran it outside the repo. `cd` in first, or use `npm run typecheck`. |
| Example 06 or 09 prints no compiler errors | The `broken/` fixtures stopped being broken, which is itself a bug. `npx tsc -p broken` should always fail. |
| Example 13 shows `?` or "could not reach" | It needs network access (no key). The registries also rate-limit; the example explains what it does about that. |
| `SyntaxError` on startup, or types not stripped | Node older than 22. `check_setup.ts` confirms your version. |
| A number that should be a number is a string | You are in example 01, in real life. Parse it. |

Still stuck? Every file is small and self-contained. Open it, read the comment at
the top, and run it directly. [tsai/schema.ts](tsai/schema.ts) is the whole
argument in one file.

---

## The series

This repo is a **companion** to a series of standalone, hands-on deep dives into
building with LLM APIs, which are taught in Python: eight core dives and a set of
bonus ones. It is not a step in that sequence and nothing in the sequence depends
on it. It exists for the reader who has decided, or been told, that their AI work
ships in TypeScript.

The concepts are the same either way, and they are the point. If you want to go
deeper on any subject this repo only touches, the Python dive on it goes much
further:

1. [OpenAI API](https://github.com/alexvervloet/openai-api-deep-dive): the API from zero
2. [Claude API](https://github.com/alexvervloet/claude-api-deep-dive): the same ideas, the Anthropic way
3. [Prompt Engineering](https://github.com/alexvervloet/prompt-engineering-deep-dive): shape model behavior with better prompts
4. [RAG](https://github.com/alexvervloet/rag-deep-dive): answer questions over your own documents
5. [Evals](https://github.com/alexvervloet/evals-deep-dive): measure whether a change actually helps
6. [Agents](https://github.com/alexvervloet/agents-deep-dive): give a model tools and a loop so it can act
7. [Prompt Injection & Guardrails](https://github.com/alexvervloet/prompt-injection-deep-dive): attack and defend all of the above
8. [Production](https://github.com/alexvervloet/ai-in-production-deep-dive): operate one app end to end

Plus bonus dives on context engineering, multimodal, fine-tuning, MCP, local
models, agent harnesses, realtime voice, observability, architecture, and
professional tooling.

Three sections here are the TypeScript-specific ones with no Python equivalent to
go read: **10** (the standard-library gap), **13** (one process, one loop) and
**14** (the ecosystem measurement). Everything else is a language translation of
a lesson the series already teaches better.
