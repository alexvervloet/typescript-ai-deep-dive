# Writing It in TypeScript

*This is the reading companion to the TypeScript deep dive. It is deliberately
not a numbered chapter of the series textbook: the series teaches AI engineering
in Python, and this is the aside for people whose work ships in TypeScript
instead. The [README](README.md) is the lab manual; this is the lecture. It
covers why a language whose types vanish at runtime turns out to be a good place
to build LLM applications, which of the differences from Python actually matter,
and the one that will take your server down.*

---

## The question, and why it is not silly

There is a widely held belief that AI engineering happens in Python, and it has
the shape of most widely held beliefs: it was true, it is becoming less true, and
the part that remains true is narrower and more specific than the belief.

The part that remains true is training. If you are fine-tuning a model, applying
LoRA adapters, quantizing weights, or doing anything else that touches the
tensors, you are in Python, and you will stay there. PyTorch, PEFT, TRL and MLX
sit on top of an ecosystem that is Python all the way down to the CUDA bindings,
and there is no TypeScript equivalent, not because nobody tried but because the
foundation is not there to build on. The lab's ecosystem measurement finds
exactly one job out of nine with no TypeScript answer, and that is the one.

The part that is no longer true is everything else. Calling a model, validating
what it said, running a tool loop, streaming to a user, counting tokens,
enforcing a schema, tracing a request: this is ordinary application work, and it
has been ordinary application work since the moment models became something you
call over HTTP rather than something you host. The official SDKs are maintained
in lockstep across both languages by the same teams. Zod is as mature as
Pydantic. LangGraph, LlamaIndex and Langfuse all ship first-party TypeScript.

Which leaves a practical question rather than a tribal one. Most software that
will use a language model is already written, and a great deal of it is written
in TypeScript: the web application the feature belongs in, the API that serves
it, the worker that processes the queue. The question is not "which language is
better for AI." It is "is there a good reason to introduce a second language and
a second deployment story into a system that does not have one." Usually there is
not, and this dive exists to make that decision on evidence rather than on
folklore.

## The fact that surprises everyone

TypeScript was designed in 2012 with an unusual constraint: it had to compile to
JavaScript that ran in browsers nobody controlled, and it had to be adoptable
file by file in codebases nobody was going to rewrite. Both pushed toward the
same decision. **The types are erased.** `tsc` checks your program, then deletes
every annotation and emits the JavaScript underneath. Nothing about your types
exists while the program runs.

For a language whose job was to make large JavaScript codebases tractable, this
was the right call, and it is a large part of why TypeScript won. It is also the
single thing that most reliably surprises somebody arriving from Python, because
Python's type hints are famously optional too, and yet in practice a Python AI
codebase reaches for Pydantic, and Pydantic checks at runtime. The mental model
that comes across the border is "the types are a bit loose but the library
enforces them." In TypeScript, by default, nothing enforces them.

This collides with language models in a specific way, and the lab's first example
is built to make the collision visible. A model returns `{"total": "12.40"}` when
your schema asked for a number. You write the line every codebase writes,
`JSON.parse(reply) as Receipt`, which compiles cleanly and is a claim with
nothing behind it. And then the interesting thing happens, which is that
JavaScript does not punish you promptly.

Multiply that string by a tax rate and you get 2.604, which is the correct
answer. Add a delivery fee to it and you get the string `"12.402.5"`. Sum three
of them and you get `"012.4012.4012.40"`. Call `.toFixed(2)` on it and, finally,
a `TypeError`, thrown in the reporting function that formats the number, hours
later, with a stack trace pointing at code that did nothing wrong.

That progression is worth more attention than the individual failures. If bad
data blew up immediately, skipping validation would be a self-correcting mistake.
Coercion is what makes it a lasting one: the first place you touch the value, it
works, so the bug survives code review, the test suite, and the first ten
thousand receipts. The lab's example prints all four results side by side because
the *pattern* is the lesson, not any one line.

## Parsing, and why it is not validating

The fix is not a better annotation, because there is no annotation that checks
anything. The fix is a runtime check that also produces the type, and in
TypeScript that is Zod: you declare a schema once, Zod validates the value while
the program runs, and TypeScript infers the static type from the same
declaration. One source of truth, enforced on both sides, which is precisely the
job Pydantic does in the Python dives.

There is a design idea underneath this that is worth naming, because it is
transferable and it predates all of these libraries. It is usually called *parse,
don't validate*: a checking function should not return a boolean and leave the
unchecked value lying around, it should return a **new value of a new type**, so
that the unchecked one is not what you are holding afterwards. The lab's
`parseModelJson` returns `{ ok: true, value: T } | { ok: false, error: string }`,
and the consequence is that reaching `.value` without first checking `.ok` does
not compile. You cannot write the classic bug where you validate and then use the
original variable anyway, because after narrowing there is no original variable
to use.

Two dials sit on top of this and both are set by default whether you decide or
not. Zod strips unknown keys unless you say `.strict()`, so a field the model
invented is silently discarded; that is often right and it is always worth
knowing. And `z.coerce.number()` will rescue `"12.40"` while still rejecting
`"about twelve"`, which is genuinely useful and costs you the signal: the day
your prompt starts returning strings for every number, a coercing schema will
never tell you. The rule the lab lands on is to coerce at edges you do not
control and stay strict on the ones you do, which puts a model's output firmly in
the first category and your own database in the second.

## What a schema cannot do, measured

Both providers will enforce a shape for you: OpenAI with a first-class
`response_format`, Anthropic by defining a single tool and requiring the model to
call it, which is a nice reminder that structured output is tool use wearing a
hat. In TypeScript the ergonomics are unusually good, because Zod 4 generates the
JSON Schema itself, so the shape the provider is shown and the validator you run
on the reply are the same object and cannot drift.

And then the experiment the lab exists for. Add a required `vatNumber` to the
schema, and hand the model a receipt that does not have one.

The expected result was fabrication. What actually happened was that
`gpt-5.4-nano` returned an empty string and `claude-haiku-4-5` returned
`"<UNKNOWN>"`. Both models declined to invent a plausible VAT number, which is
better behavior than the example predicted and which testing a second model was
required to notice.

The finding that replaced the prediction is sharper. Each model invented its own
private encoding for "this is absent," nothing documents either one, nothing
stops them changing between versions, and `z.string()` accepts both. The schema
did not prevent the bad value. It guaranteed the bad value would be a string. So
`"<UNKNOWN>"` is now in a database column that a finance export reads, indistinguishable
by type from a real VAT number.

The design lesson generalizes past this dive and past TypeScript entirely:
**every required field is a question the model is forbidden to duck.** A field
with no answer in the source is an instruction to put *something* there. Make the
schema permit ignorance, with a nullable field or an enum that has an "unknown"
member, and both models return `null` instead. The value of `null` over
`"<UNKNOWN>"` is not tidiness; it is that `null` is in the contract, so your code
can branch on it and your types can force you to.

## The half where TypeScript is ahead

It would be a poor lecture that only listed costs. There is a place where this
language is straightforwardly better for LLM work than Python, and it is the
place LLM work spends most of its time: handling a reply.

A model's reply is not a string, it is a list of typed content blocks, some text
and possibly a request to call a tool. In Python you walk that list with
`isinstance` checks or dictionary lookups and nothing verifies that you paired
the check with the right field. In TypeScript the blocks form a *discriminated
union*: one shared field whose literal value tells the compiler which shape you
are holding. Check `block.type === "tool_use"` and inside that branch the
compiler knows the block has a `name` and knows it has no `text`, and reading
`.text` there is a build failure rather than an `AttributeError` on the unlucky
request.

The stronger version is exhaustiveness. Assign the narrowed value to a variable
of type `never` in the `default` branch, and the switch is now checked for
completeness: if every case is handled there is nothing left and the assignment
is legal, and the day someone adds a variant to the union the assignment stops
being legal in every switch that does not handle it, across the whole codebase,
with nobody remembering to look. The error does not say "you missed a case," it
names the case, because the leftover type *is* the case you forgot.

This is not a small convenience. Provider APIs gain block types; the ones in use
today did not all exist two years ago. A client library that fails to build when
its assumptions expire is a materially better client library.

The honest limit is worth stating in the same breath, because it is easy to
over-read the win. What the compiler checked is that your code agrees with your
declared union. It did not check that the provider's JSON agrees with either one.
The SDKs' own response types are hand-written descriptions of an API, shipped in
a package, updated on a release schedule. They are a claim, and nothing validates
the bytes. Which is exactly why, in the lab's own type definitions, a tool call's
arguments are typed `unknown`: the compiler has nothing useful to say about them,
and saying so honestly is what forces every caller through a runtime parse.

## Promises, and a hazard

Node has no synchronous network I/O to offer, so every model call returns a
promise and every function that calls one is async. Python makes this a choice:
`OpenAI` and `AsyncOpenAI` are different clients, `def` and `async def` are
different worlds, and a codebase can reasonably stay in the synchronous one until
something needs concurrency. TypeScript deletes the choice. It costs an `await`
on your hello-world and it hands you the concurrency for free: six sequential
calls take 248ms in the lab, and the same six under `Promise.all` take 42.

Free concurrency comes with sharp edges that the compiler does not catch, because
they are all valid programs. `array.forEach(async ...)` discards every promise it
creates, so the loop finishes instantly having done nothing. `Promise.all`
rejects on the first failure and throws away the successful results with it,
which for a batch of fifty model calls, where one 503 is routine, is almost never
what was meant.

And one that is not an edge but a hazard. Since Node 15, a rejected promise that
nobody awaited does not warn, it **terminates the process**. One forgotten
`await` in a background task, on a code path that only fails when a provider is
having a bad afternoon, takes down a server that was otherwise healthy. Python's
equivalent prints "coroutine was never awaited" and carries on. There is no
review practice that reliably catches this, because it is a mistake of omission
with nothing on the page to see, which makes it one of the few situations where
the right answer really is a lint rule:
`@typescript-eslint/no-floating-promises`.

## One thread, and the thing nobody tells you

Node's defining characteristic is that your JavaScript runs on a single thread
with an event loop. This is why it is good at exactly the workload an LLM
application has: a handler that is waiting on somebody else's GPU is off the loop
entirely, so a hundred concurrent model calls cost almost nothing but memory. In
the lab's measurements, a health check served during a streaming model reply is
indistinguishable from one served while idle.

The caveat is the other side of the same coin, and it is not the GIL. Python's
lock lives in one process, and a normal deployment runs several uvicorn workers,
so a handler that blocks occupies one worker while the others keep serving. Node
has one thread per process, so a handler that blocks occupies the *entire
process*. In the lab, six hundred milliseconds of synchronous work in one handler
took a health check from 24ms to 592ms. Not slowed. Stopped.

What makes this genuinely dangerous is the second-order effect, which the lab
discovered by getting it wrong. The first version of that measurement timed the
health check from inside the same process, reported a healthy 2ms, and printed it
under the word "stalled." The busy loop had blocked the measuring code too: a
timer set for 20ms fired at 401ms, after the stall was over.

Generalize that and it is the operational lesson of this whole chapter. **A
stalled Node process cannot report that it is stalled.** The health endpoint is
on the blocked loop. So are the request timeouts, the metrics flush, and the
SIGTERM handler. A Node service that blocks its loop does not degrade visibly; it
looks fine until a load balancer outside it gives up and removes it. The remedies
are unremarkable once you know to look (keep CPU work out of the request path,
`worker_threads` when you cannot, more processes behind a balancer, and
event-loop-delay monitoring so the gaps get recorded), but knowing to look is the
entire difference.

## What to take forward

Three things, in the order they will matter.

The `unknown` boundary is the good part, and it reads as friction for about a
week. Everything arriving from outside your program is unknown until parsed, a
model's output most of all, and TypeScript will not let you pretend otherwise
unless you explicitly lie to it with `as`. Python with Pydantic reaches the same
place; the difference is that here you cannot quietly skip the step and still
read the value.

The standard-library and ecosystem gaps are real and smaller than their
reputation. Statistics is thirteen lines you write once. Binary formats are a
genuine hole. Frameworks exist and run a release behind. Training does not port
and never will. None of that is a reason to pick a language, and all of it is
worth measuring rather than assuming, which is why the lab measures it live
instead of printing a table that will be wrong next year.

The event loop is the thing to actually learn. Not the syntax, not the packages.
It is the one place where a habit carried over from a Python service produces an
outage rather than an inconvenience, and it is the one place where the
troubleshooting instinct you built somewhere else will point you in the wrong
direction.

Everything else in this dive was a translation. The ideas belong to the series,
not to the language: put the right thing in the context window, treat what comes
back as untrusted, constrain what a tool is allowed to be asked for, measure
before you claim. Those hold in any language you write them in. What changes is
which of them the compiler will help you with, and which one you have to
remember on your own.
