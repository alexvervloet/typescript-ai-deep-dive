/**
 * This file does not compile, on purpose. Example 06 runs the compiler on it and
 * prints the error.
 *
 * The scenario: you wrote a handler covering every content block that existed
 * when you wrote it. Later, someone adds a new block type to the union (say the
 * provider ships one). Nothing about this file changed. It should stop
 * compiling anyway, because it now silently ignores a case.
 *
 * The `never` assignment at the bottom is what makes that happen. Inside the
 * default branch, TypeScript has narrowed `block` down to whatever the switch
 * did not handle. If the switch is exhaustive, that is `never`, and assigning
 * `never` to `never` is fine. If it is not exhaustive, the leftover type is not
 * assignable to `never`, and the error names exactly the case you forgot.
 */

import type { ContentBlock } from "../tsai/types.ts";

export function summarize(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return `text: ${block.text}`;
    case "image":
      return `image: ${block.mediaType}`;
    case "tool_use":
      return `tool_use: ${block.name}`;
    // The "tool_result" case is missing.
    default: {
      const unhandled: never = block;
      return `unknown block: ${JSON.stringify(unhandled)}`;
    }
  }
}
