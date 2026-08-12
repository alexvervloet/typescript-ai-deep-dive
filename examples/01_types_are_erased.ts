/**
 * Example 01: your types stop at the network boundary (offline, no API call).
 *
 * If you are coming from Python with Pydantic, or from any language where a
 * type is a thing that exists while the program runs, this is the one fact to
 * absorb before anything else:
 *
 *     TypeScript's types are erased. `tsc` checks your code, then throws every
 *     type away. What executes is plain JavaScript, and it has never heard of
 *     your interfaces.
 *
 * That is fine for values you construct yourself; the compiler already checked
 * those. It is a serious problem for values that *arrive*: an HTTP response, a
 * webhook body, a row from a cache, and above all the JSON a language model
 * decided to emit. Nothing checks those. The `as` keyword especially does not:
 * it is you telling the compiler to stop asking questions.
 *
 * This example makes that concrete and then shows the cost, in euros.
 *
 * Run it:
 *
 *     npx tsx examples/01_types_are_erased.ts
 */

import { z } from "zod";
import { bold, cyan, dim, green, heading, red, table, yellow } from "../tsai/fmt.ts";

// The shape we believe a receipt-extraction model returns.
type Receipt = {
  merchant: string;
  total: number;
};

// What the model actually returned. Note `total`: a string, not a number. This
// is not a contrived failure; "12.40" instead of 12.40 is one of the most common
// things a model does when you ask for JSON without enforcing a schema.
const MODEL_REPLY = '{"merchant": "Kaffee & Co", "total": "12.40"}';

function main(): void {
  console.log(heading("1. What the compiler does check"));
  console.log(`
  This does not compile, and that is TypeScript doing its job:

      ${dim("const r: Receipt = { merchant: \"Kaffee & Co\" };")}
      ${red("Property 'total' is missing in type ...")}

  Every value you build by hand is checked. That part works exactly like the
  type checker you are hoping for.`);

  console.log(heading("2. What the compiler does not check"));

  // Here is the line. It compiles. It is also a claim with nothing behind it.
  const receipt = JSON.parse(MODEL_REPLY) as Receipt;

  console.log(`
  ${dim("const receipt = JSON.parse(reply) as Receipt;")}

  The compiler is now certain that ${cyan("receipt.total")} is a number.
  Ask JavaScript what it actually is:`);

  console.log(
    "\n" +
      table(
        [{ header: "expression" }, { header: "TypeScript believes" }, { header: "runtime truth" }],
        [
          ["receipt.merchant", "string", `${typeof receipt.merchant}  ${green("agrees")}`],
          ["receipt.total", "number", `${typeof receipt.total}  ${red("disagrees")}`],
        ],
      ),
  );

  console.log(heading("3. What that costs you"));

  // Downstream code trusts the type. Why would it not? The compiler signed off.
  const vat = receipt.total * 0.21;
  const withDelivery = receipt.total + 2.5;
  const dayTotal = [receipt, receipt, receipt].reduce((sum, r) => sum + r.total, 0);

  let toFixedResult: string;
  try {
    toFixedResult = receipt.total.toFixed(2);
  } catch (error) {
    toFixedResult = red(`threw ${(error as Error).constructor.name}: ${(error as Error).message}`);
  }

  console.log(`
  Four ordinary lines of downstream code, every one of them type-checked:

      ${dim("receipt.total * 0.21")}                     ${yellow(String(vat))}
      ${dim("receipt.total + 2.50")}                     ${yellow(JSON.stringify(withDelivery))}
      ${dim("[a, b, c].reduce((s, r) => s + r.total, 0)")}  ${yellow(JSON.stringify(dayTotal))}
      ${dim("receipt.total.toFixed(2)")}                 ${toFixedResult}

  Read those four results again, because the pattern in them is the actual
  lesson and it is worse than a crash would be.

  ${bold("Line 1 is correct.")} JavaScript coerces the string for ${cyan("*")}, so the VAT on
  EUR 12.40 really is 2.604. Nothing looks wrong. This is why the bug survives
  code review and your first ten thousand receipts.

  ${bold("Line 2 is wrong and silent.")} ${cyan("+")} means concatenation when either side is a
  string, so the delivery fee produced ${yellow('"12.402.5"')} instead of 14.90.

  ${bold("Line 3 is catastrophic and silent.")} The same coercion turns a day's
  takings into ${yellow(JSON.stringify(dayTotal))}: a number-shaped string that is off by
  orders of magnitude, sitting in whatever you write to next.

  ${bold("Line 4 finally throws")}, in a completely different function, hours later,
  with a stack trace pointing at reporting code that did nothing wrong.

  One bad value, four behaviors, and the loud one is the one you get last.`);

  console.log(heading("4. The fix is a runtime check, not a better annotation"));

  const ReceiptSchema = z.object({ merchant: z.string(), total: z.number() });
  const parsed = ReceiptSchema.safeParse(JSON.parse(MODEL_REPLY));

  console.log(`
  ${dim("const parsed = ReceiptSchema.safeParse(JSON.parse(reply));")}

  parsed.success: ${parsed.success ? green("true") : red("false")}`);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      console.log(`  ${red("caught")}: ${issue.path.join(".")}: ${issue.message}`);
    }
  }

  console.log(`
  Same value, same program, one line different, and the bad data stops at the
  door instead of becoming NaN in a report. That is the whole argument for Zod,
  and example 04 turns it into a rule you can apply everywhere.

  ${bold("The rule:")} anything that crosses into your program from outside is
  ${bold("unknown")} until you have parsed it. A model's output is the most
  outside thing in your codebase.`);
}

main();
