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
