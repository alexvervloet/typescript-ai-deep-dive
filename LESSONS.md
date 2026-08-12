# Lessons from building this dive

Things that did not go the way the plan assumed, written down while they were
fresh. The house rule for these repos is that a runnable example makes a promise
("run this and you will see X"), so every entry here is a place where the first
draft's prose and the actual output disagreed, and the output won.

---

## 1. The unchecked cast does not produce NaN, which makes it worse

**Expected.** Example 01 was written to show that `JSON.parse(reply) as Receipt`
lets a string through where a number belongs, and that downstream arithmetic
then produces `NaN`. The prose said "the first is NaN."

**What actually happened.** It printed `2.604`. JavaScript coerces a numeric
string for `*`, so `"12.40" * 0.21` is the arithmetically correct VAT. The
example's own output contradicted its headline on the first run.

**What we did.** Kept the value, threw away the claim, and measured what the
same bad value does across four adjacent operations:

| expression | result |
|---|---|
| `total * 0.21` | `2.604`, correct |
| `total + 2.50` | `"12.402.5"`, silently concatenated |
| `[a,b,c].reduce((s, r) => s + r.total, 0)` | `"012.4012.4012.40"` |
| `total.toFixed(2)` | throws `TypeError` |

**The lesson, which is stronger than the one we set out to teach.** A
wrong-typed value from a model is not reliably loud. It is correct in one
operation, silently wrong in the next, catastrophic in the third, and only
throws in the fourth, by which point the stack trace points at innocent
reporting code. "It will blow up and you will notice" is exactly the assumption
that makes people skip validation. Coercion is why it does not blow up.

**Next time.** Run the failure before describing it. JavaScript's coercion
rules are not intuitions you can reason your way to from Python, where
`"12.40" * 0.21` raises `TypeError` immediately and honestly.

---

## 2. Forced to fill a field it cannot know, neither model hallucinated

**Expected.** Example 05 was written around the claim that a required field with
no answer in the source makes the model invent a plausible value: "structured
output moved the failure from malformed JSON to well-formed fiction." The
demonstration asks for a `vatNumber` from a receipt that has none.

**What actually happened.** Neither default model invented anything.

| model | value returned for `vatNumber` |
|---|---|
| `gpt-5.4-nano` | `""` |
| `claude-haiku-4-5` | `"<UNKNOWN>"` |

Both dodged rather than fabricated, which is better behavior than the example
predicted. Testing the second model mattered: one run would have suggested
"models return empty strings," and the two together show something else.

**What we did.** Replaced the fiction claim with the measured finding, and made
the example classify its own result at runtime (empty / sentinel / concrete
value) so the printed verdict stays true whichever a future model picks.

**The lesson that replaced it, which is sharper.** The problem is not
fabrication, it is that *each model invents its own private encoding for
"absent" and `z.string()` accepts all of them*. Nothing documents `"<UNKNOWN>"`.
Nothing stops it changing between model versions. The schema did not prevent the
bad value; it guaranteed the bad value would be a string. That is a better
argument for `z.string().nullable()` than "otherwise it hallucinates," because
it survives models getting more honest.

**Next time.** When an example's headline is a claim about model *behavior*,
run at least two models before writing the sentence. One provider is an anecdote.

---

## 3. Prompt-only JSON fails differently on each provider

**Expected.** Example 05 section 1 ("ask nicely for JSON") was written assuming
it would fail, so the enforced version could rescue it.

**What actually happened.** It failed on OpenAI (`"total": "7.00"`, a string,
rejected by Zod) and *succeeded* on Claude, which returned the right shape
wrapped in the code fences the prompt had explicitly forbidden.

**What we did.** Made the section describe whichever failure it actually got,
and said plainly in the prose that the failure mode is provider-dependent.

**The lesson.** "Asking nicely worked when I tried it" is evidence about one
model on one day. This is the same trap as lesson 2 from the other direction:
a passing run does not establish reliability, and the fix is to design so that
either outcome teaches the reader something true.

---

## 4. Aborting a stream throws on two stacks out of three, and never the same way

**Expected.** Example 08 was written around "the abort is delivered as a thrown
error, so it must be caught," which is what the offline mock does and what the
web platform's `AbortSignal` documentation leads you to expect.

**What actually happened.** Three stacks, three behaviors:

| stack | on `controller.abort()` mid-stream |
|---|---|
| mock | throws, `error.name === "AbortError"` |
| openai | does not throw at all; the `for await` loop simply ends |
| claude | throws `APIUserAbortError("Request was aborted.")`, whose `.name` is `"Error"` |

All three genuinely stopped the stream. Only the delivery differed.

**Why it nearly slipped through.** The first version aborted after a fixed
number of *events*. Claude sent the whole answer in 4 deltas, so the threshold
of 8 was never reached and the section quietly demonstrated nothing while
appearing to pass. Chunk granularity is an implementation detail that varies by
an order of magnitude between providers. Counting characters instead made the
section behave the same on all three.

**What we did.** Reported the three-way split in the example itself, and taught
both halves of the handling:

```ts
try { for await (...) } catch (e) { ... }   // it might throw
if (controller.signal.aborted) { ... }      // it might not
```

**The lesson.** `catch (e) { if (e.name === "AbortError") ... }` is a natural
thing to write and it is wrong on two of these three stacks: one never throws,
and the other throws something whose `name` is `"Error"`. Checking
`signal.aborted` after the loop is the only check that works everywhere, and it
is also the only thing that distinguishes a truncated answer from a complete
one before you cache it or show it.

**Next time.** Any example whose trigger is "after N events" is measuring the
provider's chunking, not the thing it meant to measure.

---

## 5. The blocked event loop is invisible from inside the blocked process

**Expected.** Example 12 was written to show that one synchronous handler stalls
every other request. The measurement: fire a request at `/block?ms=400`, wait
20ms, then time a `/health` request from the same script.

**What actually happened.** `/health` came back in 2ms, and the example printed
that healthy number in a row labelled "stalled." The output contradicted its
own label on the first run.

**The diagnosis, which is the real lesson.** The client script and the server
were the same process, so the busy loop blocked *the measuring code too*.
Instrumenting the timeline made it obvious:

```
    3.3  client: firing /block
    7.5  server: got /block
  407.5  server: block done
  409.5  client: firing /health      <- the "20ms" timer fired at 409ms
  414.2  client: /health took 4.7ms
```

The `setTimeout(..., 20)` could not fire until the block finished, so the health
check was sent *after* the stall was over and correctly measured nothing.

**What we did.** Moved the probe into a child process (`node -e`, polling
`/health` twelve times, reporting the worst case). Measured properly: 24ms idle,
22ms while streaming a model reply, **592ms** while running 600ms of sync code.
Then kept the failed in-process attempt as its own section, because the failure
is more instructive than the success:

| | |
|---|---|
| `fetch("/block?ms=400")` | at 0ms |
| `setTimeout(..., 20)` | fired at 401ms |

**Why it matters beyond the example.** Everything you would normally use to
notice a stalled Node process runs on the stalled loop: the health endpoint,
request timeouts, the metrics flush, the SIGTERM handler. A Node service that
blocks its loop does not report itself as degraded. It looks fine until
something outside it notices.

**Next time.** When measuring a process's responsiveness, ask what the
measurement itself is running on.

---

## 6. The last turn of an agent loop needs its own system prompt

**Expected.** The capstone runs tool rounds unstreamed, then makes one final
*streamed* call for the prose (because you cannot act on half a tool call, see
lesson 4). The final call passes no tools, since it is not going to run any.

**What actually happened.** On Claude, asking "How much has Rivera spent in
total?" produced this as the final answer:

> I can see some orders from Rivera, but let me check if there are more orders
> beyond this list.

A sensible sentence, and useless as a returned answer. The model still wanted
another lookup, and the final turn had quietly removed its ability to ask for
one without telling it.

**What we did.** Gave the final turn its own system prompt saying the tools are
gone and this is the last word:

> You have now received all the tool results you are going to get, and no
> further tools are available. Answer the question using only the information
> above. If it is not enough, say exactly what is missing.

Same question afterwards produced a complete answer with a total.

**The lesson.** If your loop changes what the model can do, say so in the
prompt. A silently removed affordance reads to the model as "I will do that
next," and "next" never comes. This is not TypeScript-specific; it is a
consequence of splitting a conversation into a tool phase and an answer phase,
which any streaming agent has to do.

**A second thing that run showed, left alone on purpose.** Claude's corrected
answer counts two Rivera orders and misses a third (`A-1008`), even though the
tool returned all eight rows. Nothing in this repo would catch that: Zod
validates that an answer is well-formed, not that it is right. Only an eval
catches a wrong sum, which is the sibling dive's whole subject.
