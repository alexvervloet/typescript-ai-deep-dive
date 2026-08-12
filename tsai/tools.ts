/**
 * tsai/tools.ts: the two tools the model may call, and the gate they sit behind.
 *
 * Each tool is declared once, as a Zod schema, and that one declaration does
 * three jobs:
 *
 *   1. It becomes the JSON Schema the model is shown, so the model knows what
 *      arguments exist (`toJsonSchema`, in tsai/schema.ts).
 *   2. It validates the arguments the model sends back, which arrive as
 *      `unknown` and are not checked by anyone else.
 *   3. It gives the tool's implementation a real static type, inferred from the
 *      same schema, so the body cannot disagree with the contract.
 *
 * The important one is 2, and it is worth being blunt about why. A tool call is
 * the point where a language model's output stops being text and starts being
 * an instruction your process executes. Whatever the model puts in those
 * arguments reaches your database, your filesystem, or your payment provider.
 * The arguments are attacker-influenced input in exactly the sense a query
 * string is: anything in the conversation, including a document the user
 * uploaded, can shape them.
 *
 * So the schema is not a nicety for autocomplete. It is the perimeter, and it
 * should be as narrow as the domain allows: not "a string" but "a string
 * matching this pattern," not "a number" but "an integer from 1 to 10."
 */

import { z } from "zod";
import { describeOrder, findOrder, ordersByStatus } from "./orders.ts";
import { parseUnknown } from "./schema.ts";
import type { ToolSpec } from "./providers.ts";

/**
 * Note the regex. `z.string()` would let the model send anything at all, and
 * "anything at all" is how a tool argument becomes a path traversal or an
 * injected query in a system that does more than look things up in an array.
 * The narrowest type that still describes a real order id is the right one.
 */
export const LookupOrderArgs = z.object({
  orderId: z
    .string()
    .regex(/^A-\d{4}$/, "an order id looks like A-1003"),
});

export const ListOrdersArgs = z.object({
  status: z.enum(["pending", "shipped", "delivered", "cancelled"]).optional(),
  limit: z.number().int().min(1).max(10).optional(),
});

export const ORDER_TOOLS: ToolSpec[] = [
  {
    name: "lookup_order",
    description: "Look up one order by its id, for example A-1003.",
    parameters: LookupOrderArgs,
  },
  {
    name: "list_orders",
    description: "List orders, optionally filtered by status.",
    parameters: ListOrdersArgs,
  },
];

export type ToolOutcome = { ok: true; content: string } | { ok: false; content: string };

/**
 * Validate then run. The two steps are deliberately not separable: there is no
 * exported function here that takes `unknown` arguments and does the work.
 *
 * The `unknown` in the signature is the whole design. It comes straight off a
 * `tool_use` block, and TypeScript will not let the implementations touch it
 * until it has been through a schema.
 */
export function runTool(name: string, input: unknown): ToolOutcome {
  switch (name) {
    case "lookup_order": {
      const parsed = parseUnknown(input, LookupOrderArgs);
      if (!parsed.ok) return { ok: false, content: `invalid arguments: ${parsed.error}` };
      const order = findOrder(parsed.value.orderId);
      if (!order) return { ok: false, content: `no order with id ${parsed.value.orderId}` };
      return { ok: true, content: describeOrder(order) };
    }
    case "list_orders": {
      const parsed = parseUnknown(input, ListOrdersArgs);
      if (!parsed.ok) return { ok: false, content: `invalid arguments: ${parsed.error}` };
      const orders = ordersByStatus(parsed.value.status, parsed.value.limit ?? 5);
      if (orders.length === 0) return { ok: true, content: "no matching orders" };
      return { ok: true, content: orders.map(describeOrder).join(" | ") };
    }
    default:
      return { ok: false, content: `no such tool: ${name}` };
  }
}
