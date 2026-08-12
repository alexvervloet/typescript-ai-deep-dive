/**
 * tsai/env.ts: load `.env` with no dependency at all.
 *
 * The Python dives in this series install `python-dotenv` for this. Node has it
 * built in: `process.loadEnvFile(path)` landed in Node 21.7 and reads a `.env`
 * into `process.env`. One less package, and it behaves exactly the way the
 * series needs it to.
 *
 * The behavior that matters: **loadEnvFile does not overwrite variables that are
 * already set.** That is the same `override=False` rule python-dotenv uses, and
 * it is what makes the `secrun` workflow work. `secrun` puts your API key on the
 * environment for one command; `.env` holds only non-secret config (PROVIDER).
 * Whatever is already there wins, so a real key is never shadowed by a file.
 *
 * There is a second way to do this with no code at all:
 *
 *     node --env-file=.env script.js
 *     tsx --env-file=.env script.ts
 *
 * We call the function instead of using the flag so that every example in this
 * repo runs with a plain `tsx examples/...` and one less thing to remember.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** This file's directory, the ESM way.
 *
 * CommonJS handed you `__dirname` for free. ESM does not, because a module is
 * identified by a URL, not a path: it might not be a file at all. The three-step
 * dance below (import.meta.url -> file path -> its directory) is the standard
 * replacement, and it is the single most-Googled difference between the two
 * module systems. */
const HERE = dirname(fileURLToPath(import.meta.url));

/** The repo root, one level up from `tsai/`. */
export const ROOT = dirname(HERE);

let loaded = false;

/**
 * Load `<repo>/.env` if it exists. Safe to call many times; safe if there is no
 * `.env` at all, which is the normal state of a fresh clone.
 */
export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  const path = join(ROOT, ".env");
  if (existsSync(path)) process.loadEnvFile(path);
}

/** Read an environment variable, trimmed, with a fallback. */
export function env(name: string, fallback = ""): string {
  return (process.env[name] ?? fallback).trim();
}

/** Resolve a path relative to the repo root. */
export function fromRoot(...parts: string[]): string {
  return join(ROOT, ...parts);
}
