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
