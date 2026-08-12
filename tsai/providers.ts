/**
 * tsai/providers.ts: the ONLY file in this repo that talks to a model provider.
 *
 * Same keystone as every sibling dive: hide the provider-specific call behind a
 * small interface so the lessons are about the ideas, not about whose JSON is
 * whose. Three stacks:
 *
 *   PROVIDER=mock    a deterministic in-process model. No key, no network, no
 *                    cost. This is the default, and it is what makes most of the
 *                    repo runnable on a fresh clone.
 *   PROVIDER=openai  OpenAI chat completions        (needs OPENAI_API_KEY)
 *   PROVIDER=claude  Anthropic messages             (needs ANTHROPIC_API_KEY)
 *
 * If a real provider is selected but its key is missing (the classic "forgot
 * `secrun`"), we degrade to the mock LOUDLY: a banner on stderr and a `describe()`
 * string that says FALLBACK, so a keyless run can never be mistaken for a real
 * one. `PROVIDER_STRICT=1` turns the missing key back into a hard error, which is
 * what you want in CI.
 *
 * ---------------------------------------------------------------------------
 * What is different here from the Python version of this same file
 * ---------------------------------------------------------------------------
 *
 * 1. Every function is `async`. Not as an upgrade you opt into, the way
 *    `asyncio` is in Python, but because that is the only kind of I/O Node has.
 *    There is no synchronous `chat()` to write. See example 03.
 *
 * 2. `stream()` is an async *generator*. Python's SDKs hand you a context manager
 *    you iterate; here the natural shape is `for await (const event of stream())`,
 *    and abandoning that loop is how you cancel.
 *
 * 3. Tool arguments arrive as `unknown`, and on OpenAI they arrive as a JSON
 *    *string* that you have to parse yourself. Neither provider promises the
 *    result matches the schema you sent. Validation is not optional; it is the
 *    subject of example 07.
 */

import { z } from "zod";
import { env, loadEnv } from "./env.ts";
import { MOCK_MODEL, mockChat, mockStream } from "./mock.ts";
import { toJsonSchema } from "./schema.ts";
import type {
  ContentBlock,
  LlmResponse,
  Msg,
  StopReason,
  StreamEvent,
  Usage,
} from "./types.ts";

// Default models per stack, matching the sibling dives' cheap workhorses.
const OPENAI_CHAT = "gpt-5.4-nano";
const CLAUDE_CHAT = "claude-haiku-4-5";

const KEYS: Record<string, string[]> = {
  mock: [], // the whole point: no key required
  openai: ["OPENAI_API_KEY"],
  claude: ["ANTHROPIC_API_KEY"],
};

/** A tool the model may call. One Zod schema does two jobs: it becomes the JSON
 * Schema the model is shown, and it validates whatever the model sends back. */
export type ToolSpec = {
  name: string;
  description: string;
  parameters: z.ZodType;
};

export type ChatRequest = {
  system?: string;
  messages: Msg[];
  tools?: ToolSpec[];
  maxTokens?: number;
  /** Abort the call. Works on all three stacks. See example 09. */
  signal?: AbortSignal;
  /** Ask the provider to guarantee the reply parses as this schema (example 05). */
  responseSchema?: z.ZodType;
  /** A name for that schema. Providers require one; the mock uses it to look up
   * a canned reply, because a keyword matcher cannot fill an arbitrary schema. */
  responseSchemaName?: string;
};

// ---------------------------------------------------------------------------
// Which provider is active
// ---------------------------------------------------------------------------

/** What `.env` or the environment asked for, before any fallback. */
function configuredProvider(): string {
  loadEnv();
  return env("PROVIDER", "mock").toLowerCase();
}

function hasKeys(provider: string): boolean {
  return (KEYS[provider] ?? []).every((name) => env(name) !== "");
}

let warnedFallback = false;

function warnMockFallback(provider: string): void {
  if (warnedFallback) return;
  warnedFallback = true;
  const missing = (KEYS[provider] ?? []).join(", ");
  process.stderr.write(
    `\n!  PROVIDER=${provider} is set, but ${missing} is not on the environment.\n` +
      `   Did you forget \`secrun\`? Falling back to the offline mock so this still runs.\n` +
      `   Real model:  secrun npx tsx <script>   |   Hard error instead:  PROVIDER_STRICT=1\n\n`,
  );
}

/** The stack that will actually serve this call: 'mock', 'openai' or 'claude'. */
export function providerName(): string {
  const configured = configuredProvider();
  if (configured in KEYS && configured !== "mock" && !hasKeys(configured)) {
    if (env("PROVIDER_STRICT") !== "") return configured; // let ensureReady() complain
    warnMockFallback(configured);
    return "mock";
  }
  return configured;
}

/** The model the active stack will use. */
export function activeModel(): string {
  const byProvider: Record<string, string> = {
    mock: MOCK_MODEL,
    openai: OPENAI_CHAT,
    claude: CLAUDE_CHAT,
  };
  return byProvider[providerName()] ?? MOCK_MODEL;
}

/** One line describing the active stack. Examples print this, and it is where a
 * fallback to the mock announces itself for the second time. */
export function describe(): string {
  const configured = configuredProvider();
  const active = providerName();
  if (active === "mock" && configured !== "mock") {
    const missing = (KEYS[configured] ?? []).join(", ");
    return `mock  (FALLBACK: PROVIDER=${configured} is set but ${missing} is not on the environment)`;
  }
  if (active === "mock") return `mock  (offline, deterministic, model=${MOCK_MODEL}, no key)`;
  if (active === "openai") return `openai  (chat=${OPENAI_CHAT})`;
  if (active === "claude") return `claude  (chat=${CLAUDE_CHAT})`;
  return `unknown provider ${JSON.stringify(active)}`;
}

/** Fail fast, with a message that says what to do. Call it in any script that
 * makes a real call. Never fails for the mock; that is the point. */
export function ensureReady(): void {
  const provider = providerName();
  if (!(provider in KEYS)) {
    console.error(
      `PROVIDER=${JSON.stringify(provider)} is not recognized. ` +
        `Set PROVIDER to mock, openai or claude in .env.`,
    );
    process.exit(1);
  }
  const missing = (KEYS[provider] ?? []).filter((name) => env(name) === "");
  if (missing.length > 0) {
    console.error(
      `PROVIDER=${provider} needs ${missing.join(", ")} on the environment. ` +
        `Provide it with secrun (see ../SECRETS.md), or use PROVIDER=mock.`,
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Lazily created clients.
//
// Top-level `await import(...)` would make every script pay for both SDKs at
// startup. These helpers load one only when a call actually needs it, which is
// also why `PROVIDER=mock` works on a clone where you installed nothing but tsx.
// ---------------------------------------------------------------------------

let openaiClient: import("openai").default | undefined;
let anthropicClient: import("@anthropic-ai/sdk").default | undefined;

async function openai() {
  if (!openaiClient) {
    const { default: OpenAI } = await import("openai");
    openaiClient = new OpenAI();
  }
  return openaiClient;
}

async function anthropic() {
  if (!anthropicClient) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    anthropicClient = new Anthropic();
  }
  return anthropicClient;
}

// ---------------------------------------------------------------------------
// Translating our shapes to each provider's shapes.
//
// This is the part a provider-agnostic layer actually costs you, and it is worth
// seeing rather than hiding: the two APIs disagree about where the system prompt
// goes, how a tool result is attached, and whether tool arguments are an object
// or a string.
// ---------------------------------------------------------------------------

type OpenAIMessage = Record<string, unknown>;

function toOpenAiMessages(messages: Msg[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }
    // OpenAI keeps tool results in their own `role: "tool"` messages rather than
    // inside the user turn, so one of our messages can become several of theirs.
    const toolResults = msg.content.filter((b) => b.type === "tool_result");
    const rest = msg.content.filter((b) => b.type !== "tool_result");

    if (msg.role === "assistant") {
      const toolUses = rest.filter((b) => b.type === "tool_use");
      const text = rest
        .filter((b) => b.type === "text")
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("");
      const message: OpenAIMessage = { role: "assistant", content: text || null };
      if (toolUses.length > 0) {
        message["tool_calls"] = toolUses.map((b) => ({
          id: b.type === "tool_use" ? b.id : "",
          type: "function",
          function: {
            name: b.type === "tool_use" ? b.name : "",
            arguments: JSON.stringify(b.type === "tool_use" ? b.input : {}),
          },
        }));
      }
      out.push(message);
    } else if (rest.length > 0) {
      out.push({
        role: "user",
        content: rest.map((block) => {
          if (block.type === "image") {
            return {
              type: "image_url",
              image_url: { url: `data:${block.mediaType};base64,${block.dataBase64}` },
            };
          }
          return { type: "text", text: block.type === "text" ? block.text : "" };
        }),
      });
    }

    for (const block of toolResults) {
      if (block.type !== "tool_result") continue;
      out.push({ role: "tool", tool_call_id: block.toolUseId, content: block.content });
    }
  }
  return out;
}

function toAnthropicContent(content: string | ContentBlock[]): unknown {
  if (typeof content === "string") return content;
  return content.map((block) => {
    switch (block.type) {
      case "text":
        return { type: "text", text: block.text };
      case "image":
        return {
          type: "image",
          source: { type: "base64", media_type: block.mediaType, data: block.dataBase64 },
        };
      case "tool_use":
        return { type: "tool_use", id: block.id, name: block.name, input: block.input };
      case "tool_result":
        return {
          type: "tool_result",
          tool_use_id: block.toolUseId,
          content: block.content,
          is_error: block.isError ?? false,
        };
      default: {
        // Example 06's exhaustiveness check, doing its job in real code rather
        // than in a demo. Without it, a new ContentBlock variant would fall
        // through this switch and quietly send `undefined` to the provider,
        // because the return type is `unknown` and `unknown` accepts that.
        const unhandled: never = block;
        throw new Error(`unhandled content block: ${JSON.stringify(unhandled)}`);
      }
    }
  });
}

function openAiStopReason(reason: string | null | undefined): StopReason {
  if (reason === "tool_calls") return "tool_use";
  if (reason === "length") return "max_tokens";
  return "end";
}

function anthropicStopReason(reason: string | null | undefined): StopReason {
  if (reason === "tool_use") return "tool_use";
  if (reason === "max_tokens") return "max_tokens";
  return "end";
}

/** OpenAI hands back tool arguments as a JSON string. Parsing it can fail, and
 * when it does we keep the raw text so the caller can report something useful
 * rather than swallowing it. */
function parseToolArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return { __unparseable: raw };
  }
}

// ---------------------------------------------------------------------------
// The two calls every example uses.
// ---------------------------------------------------------------------------

/** One complete reply. */
export async function chat(request: ChatRequest): Promise<LlmResponse> {
  const provider = providerName();
  const maxTokens = request.maxTokens ?? 1024;
  const started = performance.now();

  if (provider === "mock") {
    return mockChat({
      system: request.system ?? "",
      messages: request.messages,
      toolNames: request.tools?.map((t) => t.name),
      structuredName: request.responseSchema ? (request.responseSchemaName ?? "receipt") : undefined,
      signal: request.signal,
    });
  }

  if (provider === "openai") {
    const client = await openai();
    const messages: OpenAIMessage[] = [];
    if (request.system) messages.push({ role: "system", content: request.system });
    messages.push(...toOpenAiMessages(request.messages));

    const response = await client.chat.completions.create(
      {
        model: OPENAI_CHAT,
        max_completion_tokens: maxTokens,
        messages: messages as never,
        ...(request.tools
          ? {
              tools: request.tools.map((tool) => ({
                type: "function" as const,
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: toJsonSchema(tool.parameters),
                },
              })),
            }
          : {}),
        ...(request.responseSchema
          ? {
              response_format: {
                type: "json_schema" as const,
                json_schema: {
                  name: request.responseSchemaName ?? "result",
                  strict: true,
                  schema: toJsonSchema(request.responseSchema),
                },
              },
            }
          : {}),
      },
      { signal: request.signal },
    );

    const choice = response.choices[0];
    const blocks: ContentBlock[] = [];
    const text = choice?.message.content ?? "";
    if (text) blocks.push({ type: "text", text });
    for (const call of choice?.message.tool_calls ?? []) {
      if (call.type !== "function") continue;
      blocks.push({
        type: "tool_use",
        id: call.id,
        name: call.function.name,
        input: parseToolArguments(call.function.arguments),
      });
    }
    return {
      text,
      blocks,
      model: response.model,
      usage: {
        promptTokens: response.usage?.prompt_tokens ?? 0,
        completionTokens: response.usage?.completion_tokens ?? 0,
      },
      stopReason: openAiStopReason(choice?.finish_reason),
      latencyMs: performance.now() - started,
    };
  }

  if (provider === "claude") {
    const client = await anthropic();
    // Anthropic has no "json_schema" response format. The documented way to
    // force a shape is a single tool the model is required to call, which is a
    // nice illustration that structured output IS tool use wearing a hat.
    const forcedTool = request.responseSchema
      ? {
          tools: [
            {
              name: request.responseSchemaName ?? "result",
              description: "Return the result in this exact shape.",
              input_schema: toJsonSchema(request.responseSchema) as never,
            },
          ],
          tool_choice: { type: "tool" as const, name: request.responseSchemaName ?? "result" },
        }
      : request.tools
        ? {
            tools: request.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: toJsonSchema(tool.parameters) as never,
            })),
          }
        : {};

    const response = await client.messages.create(
      {
        model: CLAUDE_CHAT,
        max_tokens: maxTokens,
        ...(request.system ? { system: request.system } : {}),
        messages: request.messages.map((msg) => ({
          role: msg.role,
          content: toAnthropicContent(msg.content) as never,
        })),
        ...forcedTool,
      },
      { signal: request.signal },
    );

    const blocks: ContentBlock[] = [];
    for (const block of response.content) {
      if (block.type === "text") blocks.push({ type: "text", text: block.text });
      else if (block.type === "tool_use") {
        blocks.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
      }
    }

    // When a schema was forced, the "answer" is the tool input. Hand it back as
    // text so callers can treat both providers identically.
    let text = blocks
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    if (request.responseSchema) {
      const forced = blocks.find((b) => b.type === "tool_use");
      if (forced?.type === "tool_use") text = JSON.stringify(forced.input, null, 2);
    }

    return {
      text,
      blocks,
      model: response.model,
      usage: {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
      },
      stopReason: request.responseSchema ? "end" : anthropicStopReason(response.stop_reason),
      latencyMs: performance.now() - started,
    };
  }

  throw new Error(`Unknown PROVIDER=${JSON.stringify(provider)}.`);
}

/**
 * The same reply, as a stream of events.
 *
 * An async generator, so the consumer drives it:
 *
 *     for await (const event of stream({ messages })) { ... }
 *
 * Breaking out of that loop, or aborting the signal, stops the producer. There
 * is no separate "close the stream" call to forget.
 */
export async function* stream(request: ChatRequest): AsyncGenerator<StreamEvent> {
  const provider = providerName();
  const maxTokens = request.maxTokens ?? 1024;

  if (provider === "mock") {
    yield* mockStream({
      system: request.system ?? "",
      messages: request.messages,
      toolNames: request.tools?.map((t) => t.name),
      signal: request.signal,
    });
    return;
  }

  if (provider === "openai") {
    const client = await openai();
    const messages: OpenAIMessage[] = [];
    if (request.system) messages.push({ role: "system", content: request.system });
    messages.push(...toOpenAiMessages(request.messages));

    const response = await client.chat.completions.create(
      {
        model: OPENAI_CHAT,
        max_completion_tokens: maxTokens,
        stream: true,
        stream_options: { include_usage: true },
        messages: messages as never,
        ...(request.tools
          ? {
              tools: request.tools.map((tool) => ({
                type: "function" as const,
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: toJsonSchema(tool.parameters),
                },
              })),
            }
          : {}),
      },
      { signal: request.signal },
    );

    // Tool arguments arrive as a *string, in fragments*. You reassemble them
    // yourself. This is the least pleasant thing in the whole SDK surface, and
    // it is the reason the capstone does its tool rounds unstreamed.
    const partial = new Map<number, { id: string; name: string; args: string }>();
    let usage: Usage = { promptTokens: 0, completionTokens: 0 };
    let stopReason: StopReason = "end";
    let model = OPENAI_CHAT;

    for await (const chunk of response) {
      model = chunk.model || model;
      if (chunk.usage) {
        usage = {
          promptTokens: chunk.usage.prompt_tokens,
          completionTokens: chunk.usage.completion_tokens,
        };
      }
      const choice = chunk.choices[0];
      if (!choice) continue;
      if (choice.finish_reason) stopReason = openAiStopReason(choice.finish_reason);
      const delta = choice.delta;
      if (delta?.content) yield { type: "text_delta", text: delta.content };
      for (const call of delta?.tool_calls ?? []) {
        const slot = partial.get(call.index) ?? { id: "", name: "", args: "" };
        if (call.id) slot.id = call.id;
        if (call.function?.name) slot.name = call.function.name;
        if (call.function?.arguments) slot.args += call.function.arguments;
        partial.set(call.index, slot);
      }
    }

    for (const slot of partial.values()) {
      yield { type: "tool_use", id: slot.id, name: slot.name, input: parseToolArguments(slot.args) };
    }
    yield { type: "done", usage, stopReason, model };
    return;
  }

  if (provider === "claude") {
    const client = await anthropic();
    const messageStream = client.messages.stream(
      {
        model: CLAUDE_CHAT,
        max_tokens: maxTokens,
        ...(request.system ? { system: request.system } : {}),
        messages: request.messages.map((msg) => ({
          role: msg.role,
          content: toAnthropicContent(msg.content) as never,
        })),
        ...(request.tools
          ? {
              tools: request.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: toJsonSchema(tool.parameters) as never,
              })),
            }
          : {}),
      },
      { signal: request.signal },
    );

    for await (const event of messageStream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield { type: "text_delta", text: event.delta.text };
      }
    }

    // The SDK assembles the partial tool-argument JSON for us, which is exactly
    // the work the OpenAI branch above does by hand.
    const final = await messageStream.finalMessage();
    for (const block of final.content) {
      if (block.type === "tool_use") {
        yield { type: "tool_use", id: block.id, name: block.name, input: block.input };
      }
    }
    yield {
      type: "done",
      model: final.model,
      stopReason: anthropicStopReason(final.stop_reason),
      usage: {
        promptTokens: final.usage.input_tokens,
        completionTokens: final.usage.output_tokens,
      },
    };
    return;
  }

  throw new Error(`Unknown PROVIDER=${JSON.stringify(provider)}.`);
}
