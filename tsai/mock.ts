/**
 * tsai/mock.ts: a deterministic, offline "model."
 *
 * Same trick as the sibling dives: an in-process function that behaves enough
 * like a chat model (text back, tool calls, streaming, token counts) that every
 * lesson runs with no key, no network and no cost. It is not intelligent and
 * does not pretend to be. It matches keywords.
 *
 * Why a repo about *TypeScript* needs one: nearly every difference this dive
 * teaches (promises, async iterators, cancellation, discriminated unions,
 * validating what came back) is visible without a real model in the loop. Paying
 * for tokens to demonstrate `for await` would be silly. The examples that
 * genuinely need a real model say so.
 *
 * The mock is also the only place in this repo that can misbehave on demand.
 * `mockBehavior` lets an example force a transient failure or hand back
 * wrong-typed tool arguments, so the error-handling and validation lessons have
 * something real to catch instead of a hypothetical.
 */

import { describeOrder, findOrder, ordersByStatus, type OrderStatus } from "./orders.ts";
import type { ContentBlock, LlmResponse, StreamEvent, StopReason, Msg } from "./types.ts";

export const MOCK_MODEL = "mock-1";

/** Knobs an example can turn to make the mock misbehave on purpose. */
export const mockBehavior = {
  /** Throw a transient-looking error on the next N calls, then recover. */
  failNext: 0,
  /** Simulated round-trip time, in milliseconds. */
  latencyMs: 40,
  /** Send tool arguments of the wrong type, the way a real model sometimes does. */
  badToolArgs: false,
  /** Wrap structured output in Markdown fences, the way a real model often does. */
  fenceJson: false,
};

/** Reset every knob. Examples call this so one demo cannot leak into the next. */
export function resetMockBehavior(): void {
  mockBehavior.failNext = 0;
  mockBehavior.latencyMs = 40;
  mockBehavior.badToolArgs = false;
  mockBehavior.fenceJson = false;
}

/** The error a flaky provider throws. Example 09 retries past it. */
export class MockTransientError extends Error {
  readonly status = 503;
  constructor() {
    super("mock provider: service temporarily unavailable");
    this.name = "MockTransientError";
  }
}

export const sleep = (msValue: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, msValue);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });

/** A crude token count. Good enough for a cost column that has to work offline. */
export function approxTokens(text: string): number {
  return Math.max(1, Math.ceil(text.trim().split(/\s+/).filter(Boolean).length * 1.3));
}

export type MockRequest = {
  system: string;
  messages: Msg[];
  toolNames?: string[];
  /** When set, the mock returns canned JSON for that schema name (see below). */
  structuredName?: string;
  signal?: AbortSignal;
};

/** Canned structured replies, keyed by schema name. The mock cannot actually
 * fill an arbitrary JSON Schema, so it looks the answer up. A real model does
 * the real thing; example 05 says which parts of its lesson need one. */
const STRUCTURED: Record<string, unknown> = {
  receipt: {
    merchant: "Kaffee & Co",
    date: "2026-06-21",
    items: [
      { name: "Flat white", price: 3.8 },
      { name: "Almond croissant", price: 3.2 },
    ],
    total: 7.0,
  },
  order_summary: {
    openOrders: 2,
    totalEur: 244.49,
    oldestOpen: "A-1003",
  },
};

const ORDER_ID = /\b[Aa]-\d{4}\b/;
const STATUS_WORDS: OrderStatus[] = ["pending", "shipped", "delivered", "cancelled"];

function lastUserText(messages: Msg[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== "user") continue;
    if (typeof msg.content === "string") return msg.content;
    const text = msg.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join(" ");
    if (text) return text;
  }
  return "";
}

/** Every tool result already in the conversation, oldest first. */
function toolResults(messages: Msg[]): Array<{ content: string; isError: boolean }> {
  const out: Array<{ content: string; isError: boolean }> = [];
  for (const msg of messages) {
    if (typeof msg.content === "string") continue;
    for (const block of msg.content) {
      if (block.type === "tool_result") {
        out.push({ content: block.content, isError: block.isError === true });
      }
    }
  }
  return out;
}

/** Decide what the mock "wants" to do with this turn. */
function plan(req: MockRequest): ContentBlock[] {
  const question = lastUserText(req.messages);
  const results = toolResults(req.messages);
  const tools = new Set(req.toolNames ?? []);

  if (req.structuredName) {
    const canned = STRUCTURED[req.structuredName] ?? {};
    const json = JSON.stringify(canned, null, 2);
    const text = mockBehavior.fenceJson ? "```json\n" + json + "\n```" : json;
    return [{ type: "text", text }];
  }

  // Already have tool output? Answer from it. This is the second half of the
  // agent loop, and the reason the mock is stateless: everything it needs is in
  // the messages it was handed.
  if (results.length > 0) {
    // A real model reads an errored tool result and tries again. The mock is not
    // that clever, but it does at least tell the two apart, so an example that
    // forces a tool failure does not print a cheerful answer built from the
    // error message.
    const failed = results.filter((r) => r.isError);
    if (failed.length > 0) {
      return [
        {
          type: "text",
          text:
            `The tool call did not go through: ${failed.map((r) => r.content).join("; ")}. ` +
            `A real model would fix the arguments and try again here.`,
        },
      ];
    }
    return [
      {
        type: "text",
        text: `Based on the order records: ${results.map((r) => r.content).join(" ")} That is what I have on file.`,
      },
    ];
  }

  const idMatch = ORDER_ID.exec(question);
  if (idMatch && tools.has("lookup_order")) {
    const orderId = idMatch[0].toUpperCase();
    return [
      {
        type: "tool_use",
        id: "call_1",
        name: "lookup_order",
        // The misbehaving branch sends a number where the schema says string.
        // Example 07 catches this at the boundary instead of crashing later.
        input: mockBehavior.badToolArgs ? { orderId: 1003 } : { orderId },
      },
    ];
  }

  const status = STATUS_WORDS.find((s) => question.toLowerCase().includes(s));
  if (tools.has("list_orders") && (status || /\b(list|how many|all|open)\b/i.test(question))) {
    return [
      {
        type: "tool_use",
        id: "call_1",
        name: "list_orders",
        input: mockBehavior.badToolArgs ? { status: "urgent" } : status ? { status } : {},
      },
    ];
  }

  // No tool fits. Answer directly, from the data, so the text is at least true.
  if (/\border/i.test(question)) {
    const lines = ordersByStatus(undefined, 3).map(describeOrder).join(" ");
    return [{ type: "text", text: `Here are the first few orders on file. ${lines}` }];
  }
  return [
    {
      type: "text",
      text:
        "I am the offline mock model. I match keywords against a small orders " +
        "dataset, so ask me about an order id like A-1003, or about pending or " +
        "shipped orders. Run under `secrun` with PROVIDER=openai or claude for a real model.",
    },
  ];
}

function stopReasonFor(blocks: ContentBlock[]): StopReason {
  return blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end";
}

/** A complete reply, after a simulated round trip. */
export async function mockChat(req: MockRequest): Promise<LlmResponse> {
  if (mockBehavior.failNext > 0) {
    mockBehavior.failNext -= 1;
    await sleep(mockBehavior.latencyMs, req.signal);
    throw new MockTransientError();
  }
  const started = performance.now();
  await sleep(mockBehavior.latencyMs, req.signal);
  const blocks = plan(req);
  const text = blocks.map((b) => (b.type === "text" ? b.text : "")).join("");
  const promptText = req.system + req.messages.map((m) => JSON.stringify(m.content)).join(" ");
  return {
    text,
    blocks,
    model: MOCK_MODEL,
    usage: { promptTokens: approxTokens(promptText), completionTokens: approxTokens(text) },
    stopReason: stopReasonFor(blocks),
    latencyMs: performance.now() - started,
  };
}

/**
 * The same reply, streamed.
 *
 * This is an async generator: `yield` hands one event to the consumer and then
 * suspends until the consumer asks for the next one. That suspension is the
 * whole point, and it is why a `for await` loop over this function can be
 * abandoned partway through (example 08) without the producer running to
 * completion.
 */
export async function* mockStream(req: MockRequest): AsyncGenerator<StreamEvent> {
  if (mockBehavior.failNext > 0) {
    mockBehavior.failNext -= 1;
    throw new MockTransientError();
  }
  await sleep(mockBehavior.latencyMs, req.signal);
  const blocks = plan(req);
  let completionTokens = 0;

  for (const block of blocks) {
    if (block.type === "text") {
      // Word by word, with a pause, so a stream looks like a stream.
      const words = block.text.split(" ");
      for (const [index, word] of words.entries()) {
        await sleep(12, req.signal);
        yield { type: "text_delta", text: index === 0 ? word : ` ${word}` };
        completionTokens += 1;
      }
    } else if (block.type === "tool_use") {
      yield { type: "tool_use", id: block.id, name: block.name, input: block.input };
    }
  }

  const promptText = req.system + req.messages.map((m) => JSON.stringify(m.content)).join(" ");
  yield {
    type: "done",
    model: MOCK_MODEL,
    stopReason: stopReasonFor(blocks),
    usage: { promptTokens: approxTokens(promptText), completionTokens },
  };
}
