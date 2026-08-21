/**
 * Setup check: run this first.
 *
 *     node --experimental-strip-types check_setup.ts     (works before npm install)
 *     npm run check                                      (after npm install)
 *
 * Checks your Node version, whether dependencies are installed, your chosen
 * PROVIDER, and the key that provider needs, then tells you exactly what to fix.
 *
 * Makes NO API calls, and imports nothing outside `node:` builtins, which is why
 * the first command above works on a clone where you have installed nothing.
 * That command is also a small demo of something Node gained recently: it runs a
 * `.ts` file directly by stripping the types out, no compiler and no `tsx` in
 * between. It only handles the erasable subset of TypeScript, so this repo still
 * uses `tsx` for everything else, but it is a real answer to "do I need a build
 * step to run TypeScript?" and the answer is increasingly no.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const USE_COLOR = process.stdout.isTTY && !process.env["NO_COLOR"];
const paint = (text: string, code: string) =>
  USE_COLOR ? `\x1b[${code}m${text}\x1b[0m` : text;
const ok = (msg: string) => console.log(`  ${paint("+", "32")} ${msg}`);
const warn = (msg: string) => console.log(`  ${paint("!", "33")} ${msg}`);
const bad = (msg: string) => console.log(`  ${paint("x", "31")} ${msg}`);

const KEYS: Record<string, string> = {
  mock: "",
  openai: "OPENAI_API_KEY",
  claude: "ANTHROPIC_API_KEY",
};

const KEY_PREFIX: Record<string, string> = {
  OPENAI_API_KEY: "sk-",
  ANTHROPIC_API_KEY: "sk-ant-",
};

/** Read `.env` by hand. We cannot use tsai/env.ts here: this file deliberately
 * imports nothing from the repo so it runs before anything is installed. */
function readEnvFile(): Record<string, string> | null {
  const path = join(HERE, ".env");
  if (!existsSync(path)) return null;
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    values[key] = value;
  }
  return values;
}

function checkNode(): boolean {
  console.log("\nNode");
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 22) {
    ok(`Node ${process.versions.node}`);
    return true;
  }
  bad(`Node ${process.versions.node}, but this repo needs 22 or newer.`);
  console.log("      Node 22 is what gives you process.loadEnvFile, a stable fetch,");
  console.log("      and the built-in test runner these lessons use.");
  return false;
}

function checkDependencies(provider: string): boolean {
  console.log("\nDependencies");
  const modules = join(HERE, "node_modules");
  if (!existsSync(modules)) {
    bad("node_modules is missing. Run:  npm install");
    return false;
  }
  const needed: Array<[string, string]> = [
    ["tsx", "runs the .ts examples directly"],
    ["typescript", "npm run typecheck"],
    ["zod", "validates everything the model says"],
    ["gpt-tokenizer", "the token-counting example"],
  ];
  if (provider === "openai") needed.push(["openai", "PROVIDER=openai"]);
  if (provider === "claude") needed.push(["@anthropic-ai/sdk", "PROVIDER=claude"]);

  let allOk = true;
  for (const [name, why] of needed) {
    if (existsSync(join(modules, name))) {
      ok(`${name}  (${why})`);
    } else {
      bad(`${name} is not installed  (${why}). Run:  npm install`);
      allOk = false;
    }
  }
  return allOk;
}

function checkProvider(envFile: Record<string, string> | null): string | null {
  console.log("\nProvider");
  if (envFile === null) {
    warn("No .env file. Using PROVIDER=mock, which needs no key.");
    console.log("      Create one when you want a real model:  cp .env.example .env");
  }
  const provider = (process.env["PROVIDER"] ?? envFile?.["PROVIDER"] ?? "mock")
    .trim()
    .toLowerCase();
  if (!(provider in KEYS)) {
    bad(`PROVIDER=${provider} is not recognized. Use mock, openai or claude.`);
    return null;
  }
  ok(`PROVIDER=${provider}`);
  if (provider === "mock") {
    console.log("      The offline model. No key, no network, no cost.");
  }
  return provider;
}

function checkKey(provider: string): boolean {
  console.log("\nAPI key");
  const keyName = KEYS[provider];
  if (!keyName) {
    ok("None needed for PROVIDER=mock.");
    return true;
  }
  const value = process.env[keyName];
  if (!value) {
    bad(`${keyName} is not on the environment.`);
    console.log("      Keys do not live in .env. Store it in your keychain and run under secrun:");
    console.log(`      secrun node --experimental-strip-types check_setup.ts`);
    console.log("      Setup takes two minutes: see ../docs/SECRETS.md");
    console.log("      Or switch to PROVIDER=mock and run the offline examples now.");
    return false;
  }
  const prefix = KEY_PREFIX[keyName];
  if (prefix && !value.startsWith(prefix)) {
    warn(`${keyName} is set but does not start with '${prefix}'. Double-check it.`);
    return true;
  }
  ok(`${keyName} is set and looks right.`);
  return true;
}

function main(): number {
  console.log(paint("Checking your setup for the TypeScript deep dive...", "1"));
  const envFile = readEnvFile();
  const nodeOk = checkNode();
  const provider = checkProvider(envFile);
  if (provider === null) {
    console.log(paint("\nFix PROVIDER in .env, then run this again.", "1;31"));
    return 1;
  }
  const depsOk = checkDependencies(provider);
  const keyOk = checkKey(provider);

  console.log();
  if (nodeOk && depsOk && keyOk) {
    console.log(paint("All set.", "1;32"));
    console.log("Start here:  npx tsx examples/01_types_are_erased.ts");
    console.log("(Twelve of the thirteen examples run with no API key, on PROVIDER=mock.)");
    return 0;
  }
  console.log(paint("Not ready yet. Fix the x items above, then run this again.", "1;31"));
  console.log("Most examples still run offline on PROVIDER=mock once npm install finishes.");
  return 1;
}

process.exit(main());
