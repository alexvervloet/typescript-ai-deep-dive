/**
 * tsai/compiler.ts: run the TypeScript compiler and capture what it says.
 *
 * Several examples in this repo make claims about what does and does not
 * compile. A comment asserting "this would be a compile error" is exactly the
 * kind of sentence that rots: someone loosens a tsconfig flag, the claim becomes
 * false, and the file keeps saying it anyway.
 *
 * So instead the examples keep deliberately-broken files in `broken/` and run
 * the real compiler on them at runtime. Slower than a comment, and true.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fromRoot } from "./env.ts";

const run = promisify(execFile);

/**
 * Type-check `broken/` and return the compiler's output.
 *
 * `tsc` reports errors on stdout and exits non-zero, so the error path is the
 * expected one here. An empty result means the broken files stopped being
 * broken, which is itself worth knowing.
 */
export async function typecheckBroken(): Promise<string> {
  try {
    const result = await run(process.execPath, [
      fromRoot("node_modules", "typescript", "bin", "tsc"),
      "-p",
      fromRoot("broken"),
    ]);
    return result.stdout.trim();
  } catch (error) {
    return ((error as { stdout?: string }).stdout ?? String(error)).trim();
  }
}

/** Just the diagnostics for one file, since each example cares about its own. */
export async function errorsIn(filename: string): Promise<string[]> {
  const output = await typecheckBroken();
  const lines = output.split("\n");
  const wanted: string[] = [];
  let capturing = false;
  for (const line of lines) {
    if (/^\S.*\.ts\(\d+,\d+\)/.test(line)) capturing = line.startsWith(filename);
    if (capturing) wanted.push(line);
  }
  return wanted;
}
