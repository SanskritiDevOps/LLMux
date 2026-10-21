import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { modelConfig } from "../../src/config/models.js";
import { listModels } from "../../src/gateway/catalog.js";
import { errorHandler } from "../../src/middleware/errorHandler.js";
import { v1Routes } from "../../src/routes/v1.routes.js";

// Mounted on a bare app so the test controls which providers count as configured,
// independent of whatever is in Backend/.env.
function appWith(enabled) {
  const app = express();
  app.use(
    "/v1",
    v1Routes({
      gateway: { chat: async () => ({}) },
      listModels: () => listModels({ config: modelConfig, enabledProviders: new Set(enabled) }),
    }),
  );
  app.use(errorHandler());
  return app;
}

describe("GET /v1/models", () => {
  it("lists the shipped aliases with only the configured providers", async () => {
    const res = await request(appWith(["gemini", "ollama"])).get("/v1/models");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      models: [
        {
          id: "fast",
          description: "Cheap and quick; falls back to a local model",
          providers: ["gemini", "ollama"],
          defaultMaxTokens: 1024,
        },
        {
          id: "smart",
          description: "Strongest available model across providers",
          providers: ["gemini"],
          defaultMaxTokens: 2048,
        },
        {
          id: "local",
          description: "Runs on the local Ollama server only",
          providers: ["ollama"],
          defaultMaxTokens: 1024,
        },
      ],
    });
  });

  it("drops aliases whose providers are all unconfigured", async () => {
    const res = await request(appWith(["ollama"])).get("/v1/models");

    expect(res.body.models.map((model) => model.id)).toEqual(["fast", "local"]);
  });

  it("returns an empty list rather than an error when nothing is configured", async () => {
    const res = await request(appWith([])).get("/v1/models");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ models: [] });
  });
});
