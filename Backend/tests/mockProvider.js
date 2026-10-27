import express from "express";

/**
 * A fake LLM provider for tests: no real provider is ever called (README section 27).
 * It speaks the Gemini and Ollama wire formats on one port, and each provider can be told
 * how to behave:
 *
 *   { type: "ok", text?, delayMs? }  answer normally, optionally after a delay
 *   { type: "status", status, body } reply with an HTTP error
 *   { type: "hang" }                 accept the request and never answer
 *   { type: "drop" }                 destroy the connection without answering
 *
 * A list of behaviors is used one per request, in order, and the last one repeats: for
 * example [{ type: "status", status: 503 }, { type: "ok" }] fails once, then answers.
 * A "status" behavior may also send `headers`, such as Retry-After.
 *
 * Streaming requests (Gemini's :streamGenerateContent, Ollama's stream: true) get the
 * answer in the provider's stream format (SSE or NDJSON). "ok" streams `text` word by
 * word, and one more behavior controls the stream in detail:
 *
 *   { type: "stream", chunks, gapMs?, then? }  send each chunk as one event, gapMs apart
 *     then: "finish" (default)  final event with the finish reason and usage
 *           "error"             the provider's own mid-stream error event
 *           "drop"              destroy the connection
 *           "stall"             go silent and keep the connection open
 *           "end"               close cleanly without ever finishing
 *
 * Every streamed event is written in two halves, so the gateway always has to join JSON
 * split across network writes. Every request is recorded, and requests whose client went
 * away before an answer was complete are counted in `aborted`, which is how tests prove
 * upstream calls get cancelled. `open` counts the requests still being answered.
 */
export async function startMockProvider() {
  const behaviors = { gemini: { type: "ok" }, ollama: { type: "ok" } };
  const requests = [];
  const state = { aborted: 0, open: 0 };

  const app = express();
  app.use(express.json());

  app.use((req, res) => {
    const gemini = req.path.match(
      /^\/v1beta\/models\/([^/]+):(generateContent|streamGenerateContent)$/,
    );
    const provider = gemini ? "gemini" : req.path === "/api/chat" ? "ollama" : null;
    const streaming = gemini ? gemini[2] === "streamGenerateContent" : req.body?.stream === true;
    if (!provider) {
      res.status(404).json({ error: "mock provider: unknown path" });
      return;
    }

    requests.push({ provider, path: req.path, headers: req.headers, body: req.body });
    state.open += 1;
    res.on("close", () => {
      state.open -= 1;
      if (!res.writableFinished) state.aborted += 1;
    });

    const queue = behaviors[provider];
    const behavior = Array.isArray(queue) ? (queue.length > 1 ? queue.shift() : queue[0]) : queue;
    if (behavior.type === "hang") return;
    if (behavior.type === "drop") {
      req.socket.destroy();
      return;
    }
    if (behavior.type === "status") {
      res
        .status(behavior.status)
        .set(behavior.headers ?? {})
        .json(behavior.body ?? {});
      return;
    }

    const text = behavior.text ?? `Hello from mock ${provider}`;
    if (streaming) {
      const chunks = behavior.type === "stream" ? behavior.chunks : text.split(/(?<= )/);
      streamAnswer(res, provider, req.body.model, chunks, behavior);
      return;
    }
    const reply = provider === "gemini" ? geminiAnswer(text) : ollamaAnswer(req.body.model, text);
    setTimeout(() => {
      if (!res.writableEnded) res.json(reply);
    }, behavior.delayMs ?? 0);
  });

  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    /** Requests still being answered; tests wait for 0 so a slow stream from one test can't be counted in the next. */
    get open() {
      return state.open;
    },
    get aborted() {
      return state.aborted;
    },
    /** @param {"gemini" | "ollama"} provider  @param {object | object[]} behavior */
    behave(provider, behavior) {
      behaviors[provider] = Array.isArray(behavior) ? [...behavior] : behavior;
    },
    reset() {
      behaviors.gemini = { type: "ok" };
      behaviors.ollama = { type: "ok" };
      requests.length = 0;
      state.aborted = 0;
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const FORMATS = {
  gemini: {
    contentType: "text/event-stream",
    frame: (json) => `data: ${JSON.stringify(json)}\r\n\r\n`,
    delta: (_model, text) => ({ candidates: [{ content: { role: "model", parts: [{ text }] } }] }),
    finish: (model, text) => ({ ...geminiAnswer(text), modelVersion: model }),
    error: () => ({
      error: { code: 503, message: "The model is overloaded.", status: "UNAVAILABLE" },
    }),
  },
  ollama: {
    contentType: "application/x-ndjson",
    frame: (json) => `${JSON.stringify(json)}\n`,
    delta: (model, text) => ({ model, message: { role: "assistant", content: text }, done: false }),
    finish: (model) => ollamaAnswer(model, ""),
    error: () => ({ error: "llama runner process has terminated" }),
  },
};

function streamAnswer(res, provider, model, chunks, { gapMs = 5, then = "finish" }) {
  const format = FORMATS[provider];
  res.writeHead(200, { "content-type": format.contentType });

  // Each event goes out as two writes, splitting its JSON in the middle.
  const writeSplit = (frame, done) => {
    const middle = Math.ceil(frame.length / 2);
    res.write(frame.slice(0, middle));
    setTimeout(() => {
      if (res.writableEnded || res.destroyed) return;
      res.write(frame.slice(middle));
      done();
    }, 1);
  };

  const next = (index) => {
    if (res.writableEnded || res.destroyed) return;
    if (index < chunks.length) {
      writeSplit(format.frame(format.delta(model, chunks[index])), () =>
        setTimeout(() => next(index + 1), gapMs),
      );
      return;
    }
    if (then === "stall") return;
    if (then === "drop") {
      res.socket.destroy();
      return;
    }
    if (then === "end") {
      res.end();
      return;
    }
    const last = then === "error" ? format.error() : format.finish(model, "");
    writeSplit(format.frame(last), () => res.end());
  };
  next(0);
}

function geminiAnswer(text) {
  return {
    candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 },
  };
}

function ollamaAnswer(model, text) {
  return {
    model,
    message: { role: "assistant", content: text },
    done: true,
    done_reason: "stop",
    prompt_eval_count: 10,
    eval_count: 20,
  };
}
