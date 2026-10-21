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
 * Every request is recorded, and requests whose client went away before an answer was
 * sent are counted in `aborted`, which is how tests prove upstream calls get cancelled.
 */
export async function startMockProvider() {
  const behaviors = { gemini: { type: "ok" }, ollama: { type: "ok" } };
  const requests = [];
  const state = { aborted: 0 };

  const app = express();
  app.use(express.json());

  app.use((req, res) => {
    const gemini = req.path.match(/^\/v1beta\/models\/([^/]+):generateContent$/);
    const provider = gemini ? "gemini" : req.path === "/api/chat" ? "ollama" : null;
    if (!provider) {
      res.status(404).json({ error: "mock provider: unknown path" });
      return;
    }

    requests.push({ provider, path: req.path, headers: req.headers, body: req.body });
    res.on("close", () => {
      if (!res.writableFinished) state.aborted += 1;
    });

    const behavior = behaviors[provider];
    if (behavior.type === "hang") return;
    if (behavior.type === "drop") {
      req.socket.destroy();
      return;
    }
    if (behavior.type === "status") {
      res.status(behavior.status).json(behavior.body ?? {});
      return;
    }

    const text = behavior.text ?? `Hello from mock ${provider}`;
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
    get aborted() {
      return state.aborted;
    },
    /** @param {"gemini" | "ollama"} provider */
    behave(provider, behavior) {
      behaviors[provider] = behavior;
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
