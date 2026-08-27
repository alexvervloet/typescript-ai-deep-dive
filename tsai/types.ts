/**
 * tsai/types.ts: the shapes every other file agrees on.
 *
 * This is where TypeScript stops being annotation and starts catching mistakes,
 * so it is worth reading before any of the code that uses it.
 *
 * A model's reply is not a string. It is a list of **typed content blocks**: some
 * text, maybe a request to call a tool, maybe an image you sent back. In Python
 * you receive that as a list of objects and reach into them with `isinstance` or
 * dictionary keys, and nothing checks that you got it right. Here each block is a
 * member of a **discriminated union**: one shared field (`type`) whose literal
 * value tells the compiler which shape you are holding.
 *
 *     if (block.type === "tool_use") {
 *       block.name   // fine, the compiler knows this branch has a name
 *       block.text   // compile error, tool_use blocks have no text
 *     }
 *
 * That narrowing is free, and it is checked. Example 06 turns it into an
 * exhaustive `switch` that fails to compile the day a new block type appears,
 * which is the behavior you actually want from a client library.
 *
 * Now the honest other half, and the reason this repo exists.
 *
 * Look at `ToolUseBlock.input`. It is `unknown`, not an object shape, because
 * that value came off the network from a model that is free to send whatever it
 * likes. A type annotation would be a claim, not a check: TypeScript's types are
 * erased before the program runs, so nothing would verify it. `unknown` is the
 * truthful type, and it forces every caller to validate before use. See
 * `tsai/schema.ts`.
 */

/** Plain text from the model, or from you. */
export type TextBlock = { type: "text"; text: string };

/** An image, base64-encoded, riding in the same turn as your question. */
export type ImageBlock = { type: "image"; mediaType: string; dataBase64: string };

/**
 * The model asking you to run a tool.
 *
 * `input` is `unknown` on purpose. The model chose those arguments; they are
 * untrusted input in exactly the sense example 07 demonstrates. Parse them with
 * the tool's schema before you touch them.
 */
export type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown };

/** Your answer to a `tool_use`, handed back to the model on the next turn. */
export type ToolResultBlock = {
  type: "tool_result";
  toolUseId: string;
  content: string;
  isError?: boolean;
};

/** Everything that can appear in a turn. The `type` field is the discriminant. */
export type ContentBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock;

/** One turn of the conversation. */
export type Msg = {
  role: "user" | "assistant";
  content: string | ContentBlock[];
};

/** Why the model stopped talking. `tool_use` is the one that drives the agent loop. */
export type StopReason = "end" | "tool_use" | "max_tokens";

/** Token accounting, normalized across providers. */
export type Usage = { promptTokens: number; completionTokens: number };

/** One complete, non-streamed reply. */
export type LlmResponse = {
  /** Every text block joined together, which is what most callers want. */
  text: string;
  /** The full block list, for callers that care about tool use. */
  blocks: ContentBlock[];
  model: string;
  usage: Usage;
  stopReason: StopReason;
  latencyMs: number;
};

/**
 * A streamed reply, event by event. Another discriminated union, so a `switch`
 * over it is exhaustive and the compiler tells you when you forgot a case.
 */
export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "done"; usage: Usage; stopReason: StopReason; model: string };

/** Helper: pull the text out of a block list. */
export function textOf(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** Helper: the tool calls the model asked for, if any. */
export function toolUsesOf(blocks: ContentBlock[]): ToolUseBlock[] {
  return blocks.filter((b): b is ToolUseBlock => b.type === "tool_use");
}
