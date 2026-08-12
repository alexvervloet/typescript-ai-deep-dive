/**
 * Also does not compile, on purpose. Example 06 prints the error.
 *
 * Two mistakes, both of which a Python version of this code would make at
 * runtime, in production, on a block that happened to be the wrong kind:
 *
 *   1. Reading `.text` off a block before checking what kind of block it is.
 *   2. Reading `.text` off a block that has been narrowed to `tool_use`, which
 *      has no such field.
 *
 * The second one is the interesting one. The compiler is not guessing; it knows
 * that inside this branch the block is a `ToolUseBlock`, because the `type`
 * check told it so.
 */

import type { ContentBlock } from "../tsai/types.ts";

export function firstText(blocks: ContentBlock[]): string {
  const first = blocks[0];
  if (!first) return "";

  // 1. No narrowing at all. Only TextBlock has `text`.
  const careless = first.text;

  // 2. Narrowed, and then asked for the wrong field.
  if (first.type === "tool_use") {
    return first.text;
  }
  return careless;
}
