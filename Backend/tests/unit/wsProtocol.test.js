import { describe, expect, it } from "vitest";
import { sizeToBytes } from "../../src/transports/websocket.js";
import { errorMessage, parseClientMessage } from "../../src/transports/wsProtocol.js";
import { GatewayError } from "../../src/utils/errors.js";

const frame = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
const parse = (value, isBinary = false) => parseClientMessage(frame(value), isBinary);

function rejection(value, isBinary) {
  try {
    parse(value, isBinary);
  } catch (err) {
    return err;
  }
  throw new Error("expected the message to be rejected");
}

const chat = (fields) => ({
  type: "chat",
  requestId: "c1",
  model: "fast",
  messages: [{ role: "user", content: "Hi" }],
  ...fields,
});

describe("parseClientMessage", () => {
  it("accepts the four message types from the README", () => {
    expect(parse({ type: "auth", apiKey: "llmux_sk_abc" })).toEqual({
      type: "auth",
      apiKey: "llmux_sk_abc",
    });
    expect(parse({ type: "cancel", requestId: "c1" })).toEqual({ type: "cancel", requestId: "c1" });
    expect(parse({ type: "ping" })).toEqual({ type: "ping" });
  });

  it("checks a chat with the same rules and defaults as POST /v1/chat", () => {
    expect(parse(chat({ system: "Be brief." }))).toEqual({
      type: "chat",
      requestId: "c1",
      model: "fast",
      system: "Be brief.",
      messages: [{ role: "user", content: "Hi" }],
      temperature: 0.7,
      cache: true,
    });

    const error = rejection(chat({ temperature: 9 }));
    expect(error).toBeInstanceOf(GatewayError);
    expect(error.code).toBe("INVALID_REQUEST");
    expect(error.message).toContain("temperature");
  });

  it("rejects `stream`, since WebSocket chats always stream", () => {
    expect(rejection(chat({ stream: false })).message).toContain('Unrecognized key: "stream"');
  });

  it("returns the requestId with a rejected chat, so the client knows which one failed", () => {
    const error = rejection(chat({ messages: [] }));

    expect(error.requestId).toBe("c1");
    expect(error.message).toContain("messages: must contain at least one message");
  });

  it.each([
    ["an empty id", ""],
    ["a space", "c 1"],
    ["65 characters", "x".repeat(65)],
    ["a number", 7],
  ])("rejects a requestId with %s, without echoing it", (_label, requestId) => {
    const error = rejection(chat({ requestId }));

    expect(error.requestId).toBeUndefined();
    expect(error.message).toMatch(
      /requestId: (must be 1-64 letters|Invalid input: expected string)/,
    );
  });

  it.each([
    ["broken JSON", "{nope", "Message is not valid JSON"],
    ["a JSON array", "[1,2]", "Invalid request: message must be a JSON object"],
    ["a JSON string", '"hello"', "Invalid request: message must be a JSON object"],
    ["null", "null", "Invalid request: message must be a JSON object"],
    [
      "an unknown type",
      { type: "subscribe" },
      "Invalid request: type must be one of auth, chat, cancel, ping",
    ],
    ["no type", { apiKey: "x" }, "Invalid request: type must be one of auth, chat, cancel, ping"],
    ["an unknown field", { type: "ping", extra: 1 }, 'Unrecognized key: "extra"'],
    ["auth without a key", { type: "auth" }, "apiKey"],
  ])("rejects %s with a clear message", (_label, value, message) => {
    const error = rejection(value);

    expect(error.code).toBe("INVALID_REQUEST");
    expect(error.message).toContain(message);
  });

  it("rejects binary frames", () => {
    expect(rejection({ type: "ping" }, true).message).toBe(
      "Messages must be text frames containing JSON",
    );
  });

  it("never echoes a rejected value, which could be a secret in the wrong field", () => {
    const error = rejection({ type: "cancel", requestId: "c1", apiKey: "llmux_sk_secret" });

    expect(error.message).not.toContain("llmux_sk_secret");
  });
});

describe("errorMessage", () => {
  it("builds the error message, with or without a requestId", () => {
    const error = new GatewayError("RATE_LIMITED", "Too many");

    expect(errorMessage(error, "c1")).toEqual({
      type: "error",
      requestId: "c1",
      code: "RATE_LIMITED",
      message: "Too many",
    });
    expect(errorMessage(error)).toEqual({
      type: "error",
      code: "RATE_LIMITED",
      message: "Too many",
    });
  });
});

describe("sizeToBytes", () => {
  it.each([
    ["1mb", 1024 * 1024],
    ["100kb", 100 * 1024],
    ["512b", 512],
    ["2MB", 2 * 1024 * 1024],
  ])("converts %s", (size, bytes) => {
    expect(sizeToBytes(size)).toBe(bytes);
  });
});
