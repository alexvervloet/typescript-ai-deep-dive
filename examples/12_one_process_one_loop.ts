/**
 * Example 12: serving it, and the one thing that will bite you (offline).
 *
 * Putting a model behind HTTP is where TypeScript's story is strongest and where
 * its single genuine architectural difference from Python lives. Both halves are
 * in this file, measured.
 *
 * The strong half: streaming tokens to a browser is about thirty lines of
 * standard library. No framework, no ASGI server, no worker configuration. The
 * server below is `node:http` and `fetch`, both built in.
 *
 * The other half: Node runs your JavaScript on ONE thread. Not one process with
 * a lock that releases on I/O, which is what Python's GIL does. One thread, one
 * event loop, and while your code is running nothing else in that process can.
 * Every request in this process shares it. Sections 2 and 3 measure what that
 * costs when a single handler forgets and does synchronous work.
 *
 *     npx tsx examples/12_one_process_one_loop.ts
 */

import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { bold, cyan, dim, green, heading, ms, red, table, yellow } from "../tsai/fmt.ts";
import { resetMockBehavior } from "../tsai/mock.ts";
import { stream } from "../tsai/providers.ts";

const run = promisify(execFile);

resetMockBehavior();

// ---------------------------------------------------------------------------
// The server. Three routes: an instant one, a streaming one, and one that
// behaves badly on purpose.
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }

  if (url.pathname === "/block") {
    // A synchronous busy loop. Nothing else in this process runs until it ends.
    // Real code does not look like this; real code does JSON.parse on a 40MB
    // payload, or hashes something, or renders a big template synchronously.
    // The effect is identical.
    const until = Date.now() + Number(url.searchParams.get("ms") ?? 400);
    while (Date.now() < until) {
      /* deliberately blocking */
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("done blocking");
    return;
  }

  if (url.pathname === "/stream") {
    // Server-sent events: the format every streaming chat UI on the web uses.
    // Three headers and `data: ...\n\n` per message.
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    for await (const event of stream({
      system: "Be brief.",
      messages: [{ role: "user", content: url.searchParams.get("q") ?? "list orders" }],
    })) {
      if (event.type === "text_delta") res.write(`data: ${JSON.stringify(event.text)}\n\n`);
      if (event.type === "done") res.write("data: [DONE]\n\n");
    }
    res.end();
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as AddressInfo;
const base = `http://127.0.0.1:${port}`;

// ---------------------------------------------------------------------------

console.log(heading("1. Streaming to a client, in thirty lines"));

process.stdout.write("\n  ");
const response = await fetch(`${base}/stream?q=list%20pending%20orders`);
let buffer = "";
for await (const chunk of response.body as ReadableStream<Uint8Array>) {
  buffer += new TextDecoder().decode(chunk);
  // SSE messages are separated by a blank line. Real clients use EventSource
  // in the browser, which does this parsing for you.
  const messages = buffer.split("\n\n");
  buffer = messages.pop() ?? "";
  for (const message of messages) {
    const data = message.replace(/^data: /, "");
    if (data === "[DONE]") continue;
    process.stdout.write(JSON.parse(data) as string);
  }
}

console.log(`

  That is the whole streaming stack: ${cyan("node:http")} on the server, ${cyan("fetch")} on the
  client, ${cyan("EventSource")} in a browser. All three are standard. The equivalent in
  the Python dives needs FastAPI and uvicorn, which are excellent and are two
  dependencies and a process manager.`);

// ---------------------------------------------------------------------------

console.log(heading("2. Measuring the loop, from outside it"));

/**
 * Poll /health from a SEPARATE process and report the worst latency seen.
 *
 * The separate process is not fussiness. The first draft of this example timed
 * /health from right here, and section 4 is the story of why that produced a
 * confidently wrong answer.
 */
async function probeFromAnotherProcess(): Promise<number> {
  const code = `(async () => {
    const seen = [];
    for (let i = 0; i < 12; i++) {
      const started = performance.now();
      try { await (await fetch("${base}/health")).text(); } catch {}
      seen.push(performance.now() - started);
      await new Promise((r) => setTimeout(r, 40));
    }
    console.log(JSON.stringify(Math.max(...seen)));
  })()`;
  const { stdout } = await run(process.execPath, ["-e", code]);
  return Number(stdout.trim());
}

console.log(`\n  ${dim("polling /health 12 times from a child process, worst case reported")}`);

const idle = await probeFromAnotherProcess();

// A slow request that is slow because of I/O. It awaits, so the loop stays free.
const streamProbe = probeFromAnotherProcess();
await new Promise((r) => setTimeout(r, 100));
await fetch(`${base}/stream`).then((r) => r.text());
const duringStream = await streamProbe;

// A slow request that is slow because of computation.
const blockProbe = probeFromAnotherProcess();
await new Promise((r) => setTimeout(r, 100));
await fetch(`${base}/block?ms=600`).then((r) => r.text());
const duringBlock = await blockProbe;

console.log(
  "\n" +
    table(
      [
        { header: "while the server is..." },
        { header: "worst /health", align: "right" },
        { header: "" },
      ],
      [
        ["idle", ms(idle), ""],
        ["streaming a model reply (awaits)", ms(duringStream), green("unaffected")],
        ["running 600ms of sync code", ms(duringBlock), red("stalled")],
      ],
    ),
);

console.log(`
  The middle row is the good news and it is the normal case: a handler that
  ${cyan("await")}s is off the loop entirely while it waits, so a hundred concurrent model
  calls cost almost nothing but memory. This is the thing Node is famously good
  at, and for an LLM gateway (which is mostly waiting on someone else's GPU) it
  is close to the ideal shape.

  The bottom row is the whole caveat. ${bold("One handler doing synchronous work froze")}
  ${bold("every other request in the process")}, including a health check that touches
  nothing. Not slowed: stopped. The event loop had no opportunity to run them.

  ${yellow("This is not the GIL, and the difference matters.")} A blocking handler under
  uvicorn occupies one worker process of several, so the others keep serving. Node
  has one thread per process, so a blocking handler occupies the entire process.`);

// ---------------------------------------------------------------------------

console.log(heading("3. Why that measurement needed a second process"));

// Fire the blocking route, then try to do something 20ms later, from inside
// this process. Record when that "20ms later" actually happens.
const firedAt = performance.now();
const blockingAgain = fetch(`${base}/block?ms=400`).then((r) => r.text());
const timerFiredAt = await new Promise<number>((resolve) =>
  setTimeout(() => resolve(performance.now()), 20),
);
await blockingAgain;

const delay = timerFiredAt - firedAt;

console.log(`
    ${dim("fetch(\"/block?ms=400\")")}                 ${dim(`at ${ms(0)}`)}
    ${dim("setTimeout(..., 20)")}                    ${
      delay > 100 ? red(`fired at ${ms(delay)}`) : green(`fired at ${ms(delay)}`)
    }

  ${bold(`A 20ms timer took ${ms(delay)}.`)} The server and this script share one process,
  so while the handler was busy-looping, this code was not running either. The
  first version of this example timed /health from here, got a healthy-looking
  number, and reported "stalled" next to it. The timer that was supposed to fire
  during the stall could only fire after it.

  ${bold("The stall is invisible from inside the process that is stalled.")} That is not
  a quirk of this example, it is the operational shape of the problem, and it
  generalizes to everything you would normally rely on:

    ${red("your /health endpoint")}        cannot answer while the loop is blocked
    ${red("your request timeouts")}        are timers, and timers do not fire
    ${red("your metrics flush")}           is queued behind the block
    ${red("your graceful shutdown")}       will not notice SIGTERM until it ends

  So a Node service that blocks its loop does not look degraded. It looks fine,
  right up until the load balancer's own health check times out from outside and
  removes it. Watch for it with ${cyan("perf_hooks")} event-loop-delay monitoring, which
  samples from the loop itself and reports the gaps afterwards.`);

console.log(`
${heading("4. What you do about it")}

    ${green("do not do CPU work in the request path")}   ${dim("the real answer, most of the time")}
    ${green("node:worker_threads")}                      ${dim("move the CPU work off the loop")}
    ${green("node:cluster, or N containers")}            ${dim("more loops, the uvicorn answer")}

  And the thing to watch for in an LLM app specifically: a large ${cyan("JSON.parse")} on a
  retrieved document, synchronous ${cyan("crypto")}, a big regex over a whole context
  window, or a tokenizer counting a corpus (example 11) in a request handler.
  None of them look like a busy loop. All of them are one.`);

server.close();
