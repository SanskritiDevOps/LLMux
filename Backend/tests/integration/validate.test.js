import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "../../src/app.js";
import { formatIssues, validate } from "../../src/middleware/validate.js";
import { captureLogs } from "../helpers/captureLogs.js";

const BodySchema = z.strictObject({
  model: z.string().min(1),
  temperature: z.number().max(2).default(0.7),
});
const QuerySchema = z.strictObject({ limit: z.coerce.number().int().max(200).default(50) });
const ParamsSchema = z.strictObject({ id: z.uuid() });

const app = createApp({
  logger: captureLogs().logger,
  extraRoutes: (app) => {
    app.post("/things", validate({ body: BodySchema }), (req, res) => {
      res.json({ validated: req.validated.body, raw: req.body });
    });
    app.get("/things", validate({ query: QuerySchema }), (req, res) => {
      res.json(req.validated.query);
    });
    app.get("/things/:id", validate({ params: ParamsSchema }), (req, res) => {
      res.json(req.validated.params);
    });
  },
});

describe("validate middleware", () => {
  it("passes parsed values with defaults to the handler on req.validated", async () => {
    const res = await request(app).post("/things").send({ model: "fast" });

    expect(res.status).toBe(200);
    expect(res.body.validated).toEqual({ model: "fast", temperature: 0.7 });
    expect(res.body.raw).toEqual({ model: "fast" });
  });

  it("rejects an invalid body with the unified INVALID_REQUEST error", async () => {
    const res = await request(app).post("/things").send({ model: "fast", temperature: 5 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      code: "INVALID_REQUEST",
      requestId: res.headers["x-request-id"],
      retryable: false,
    });
    expect(res.body.error.message).toMatch(/^Invalid request: temperature: /);
  });

  it("names unknown fields so typos are obvious", async () => {
    const res = await request(app).post("/things").send({ model: "fast", max_tokens: 10 });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("max_tokens");
  });

  it("treats a missing body as an empty object", async () => {
    const res = await request(app).post("/things");

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("model:");
  });

  it("does not echo rejected values back to the client", async () => {
    const res = await request(app).post("/things").send({ model: 12345678 });

    expect(res.status).toBe(400);
    expect(res.body.error.message).not.toContain("12345678");
  });

  it("validates and coerces query strings", async () => {
    const ok = await request(app).get("/things?limit=10");
    const bad = await request(app).get("/things?limit=999");

    expect(ok.body).toEqual({ limit: 10 });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toContain("limit:");
  });

  it("validates route params", async () => {
    const res = await request(app).get("/things/not-a-uuid");

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("id:");
  });
});

describe("formatIssues", () => {
  const issue = (path, message) => ({ path, message });

  it("uses the request part as the path for top-level issues", () => {
    expect(formatIssues([issue([], "Invalid input: expected object")], "body")).toBe(
      "Invalid request: body: Invalid input: expected object",
    );
  });

  it("lists at most five issues and counts the rest", () => {
    const issues = Array.from({ length: 7 }, (_, i) => issue([`f${i}`], "bad"));

    expect(formatIssues(issues, "body")).toBe(
      "Invalid request: f0: bad; f1: bad; f2: bad; f3: bad; f4: bad; and 2 more",
    );
  });
});
