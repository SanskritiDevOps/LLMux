import { afterEach, describe, expect, it, vi } from "vitest";
import { FLUSH_INTERVAL_MS, createUsageWriter } from "../../src/modules/usage/usageWriter.js";
import { captureLogs } from "../helpers/captureLogs.js";

/** An in-memory usage repository; `failing` makes every insert reject, like Postgres down. */
function fakeRepository() {
  const repository = {
    failing: false,
    batches: [],
    stored: new Map(),
    async insertMany(rows) {
      if (repository.failing) {
        throw Object.assign(new Error("connection refused (fake)"), { code: "ECONNREFUSED" });
      }
      // Like Postgres: one row the database refuses fails the whole statement.
      if (rows.some((row) => row.apiKeyId === "deleted-key")) {
        throw Object.assign(new Error("Foreign key constraint violated (fake)"), {
          code: "P2003",
        });
      }
      repository.batches.push(rows.map((row) => row.requestId));
      let inserted = 0;
      for (const row of rows) {
        if (!repository.stored.has(row.requestId)) {
          repository.stored.set(row.requestId, row);
          inserted += 1;
        }
      }
      return inserted;
    },
  };
  return repository;
}

const row = (n) => ({ requestId: `req_${n}`, apiKeyId: "key-1", status: "success" });

const writers = [];
function setup(options = {}) {
  const repository = fakeRepository();
  const logs = captureLogs();
  const writer = createUsageWriter({ repository, logger: logs.logger, ...options });
  writers.push(writer);
  return { writer, repository, logs };
}

afterEach(async () => {
  vi.useRealTimers();
  for (const writer of writers.splice(0)) await writer.close();
});

describe("createUsageWriter", () => {
  it("returns from record() at once, without writing anything yet", () => {
    const { writer, repository } = setup();

    expect(writer.record(row(1))).toBeUndefined();
    expect(repository.batches).toEqual([]);
    expect(writer.stats()).toMatchObject({ buffered: 1, written: 0 });
  });

  it("writes waiting rows every second, in one batch", async () => {
    vi.useFakeTimers();
    const { writer, repository } = setup();
    writer.record(row(1));
    writer.record(row(2));

    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);

    expect(repository.batches).toEqual([["req_1", "req_2"]]);
    expect(writer.stats()).toMatchObject({ buffered: 0, written: 2 });
  });

  it("writes straight away once a full batch is waiting", async () => {
    const { writer, repository } = setup({ batchSize: 3, flushIntervalMs: 60_000 });
    for (const n of [1, 2, 3]) writer.record(row(n));

    await vi.waitFor(() => expect(repository.batches).toEqual([["req_1", "req_2", "req_3"]]));
  });

  it("splits a large backlog into batches of the batch size", async () => {
    const { writer, repository } = setup({ batchSize: 2, flushIntervalMs: 60_000 });
    repository.failing = true;
    for (const n of [1, 2, 3, 4, 5]) writer.record(row(n));
    await writer.flush();
    repository.failing = false;

    await writer.flush();

    expect(repository.batches).toEqual([["req_1", "req_2"], ["req_3", "req_4"], ["req_5"]]);
  });

  it("keeps rows in memory while the database is down, then writes them in order", async () => {
    const { writer, repository, logs } = setup({ flushIntervalMs: 60_000 });
    repository.failing = true;
    writer.record(row(1));
    writer.record(row(2));
    await writer.flush();
    await writer.flush();

    expect(writer.stats()).toMatchObject({ buffered: 2, written: 0, failedBatches: 2 });
    // One warning for the outage, not one per retry.
    const warnings = logs.lines.filter((line) => line.msg.startsWith("Could not write usage logs"));
    expect(warnings).toHaveLength(1);

    repository.failing = false;
    writer.record(row(3));
    await writer.flush();

    expect([...repository.stored.keys()]).toEqual(["req_1", "req_2", "req_3"]);
    expect(logs.lines.some((line) => line.msg === "Usage log writes recovered")).toBe(true);
  });

  it("drops only a row the database refuses, instead of retrying its batch forever", async () => {
    const { writer, repository, logs } = setup({ flushIntervalMs: 60_000 });
    writer.record(row(1));
    writer.record({ ...row(2), apiKeyId: "deleted-key" });
    writer.record(row(3));

    await writer.flush();

    expect([...repository.stored.keys()]).toEqual(["req_1", "req_3"]);
    expect(writer.stats()).toMatchObject({ buffered: 0, written: 2, dropped: 1 });
    expect(logs.lines.find((line) => line.msg.includes("refused by the database"))).toMatchObject({
      requestId: "req_2",
    });
  });

  it("keeps the rest of a batch if the database goes down while it writes row by row", async () => {
    const { writer, repository } = setup({ flushIntervalMs: 60_000 });
    writer.record({ ...row(1), apiKeyId: "deleted-key" });
    writer.record(row(2));
    const insertMany = repository.insertMany;
    let calls = 0;
    repository.insertMany = async (rows) => {
      calls += 1;
      // The batch fails on its bad row, then the database goes away.
      if (calls === 3) repository.failing = true;
      return insertMany(rows);
    };

    await writer.flush();

    expect(writer.stats()).toMatchObject({ buffered: 1, dropped: 1, failedBatches: 1 });
    repository.failing = false;
    await writer.flush();
    expect([...repository.stored.keys()]).toEqual(["req_2"]);
  });

  it("never throws from record(), even while the database is down", () => {
    const { writer, repository } = setup({ batchSize: 1 });
    repository.failing = true;

    expect(() => writer.record(row(1))).not.toThrow();
  });

  it("drops the oldest rows once the buffer is full, and says so", async () => {
    const { writer, repository, logs } = setup({ maxBuffered: 3, flushIntervalMs: 60_000 });
    repository.failing = true;
    for (const n of [1, 2, 3, 4, 5]) writer.record(row(n));
    repository.failing = false;

    await writer.flush();

    expect([...repository.stored.keys()]).toEqual(["req_3", "req_4", "req_5"]);
    expect(writer.stats().dropped).toBe(2);
    expect(logs.lines.some((line) => line.msg.includes("dropped the oldest rows"))).toBe(true);
  });

  it("shares one write between flushes that overlap", async () => {
    const { writer, repository } = setup({ flushIntervalMs: 60_000 });
    writer.record(row(1));

    await Promise.all([writer.flush(), writer.flush()]);

    expect(repository.batches).toEqual([["req_1"]]);
  });

  it("does not write a request twice when a batch is retried", async () => {
    const { writer, repository } = setup({ flushIntervalMs: 60_000 });
    writer.record(row(1));
    await writer.flush();
    writer.record(row(1));
    await writer.flush();

    expect(repository.stored.size).toBe(1);
  });

  it("warns when rows are skipped because their request_id is already stored", async () => {
    const { writer, logs } = setup({ flushIntervalMs: 60_000 });
    // For example a client that sent the same X-Request-Id twice.
    writer.record(row(1));
    writer.record(row(1));

    await writer.flush();

    expect(logs.lines.find((line) => line.msg.startsWith("Skipped usage rows"))).toMatchObject({
      skipped: 1,
    });
  });

  it("writes everything left on close(), and refuses rows after it", async () => {
    const { writer, repository, logs } = setup({ flushIntervalMs: 60_000 });
    writer.record(row(1));

    await writer.close();
    writer.record(row(2));

    expect([...repository.stored.keys()]).toEqual(["req_1"]);
    expect(writer.stats().dropped).toBe(1);
    expect(logs.lines.some((line) => line.msg.includes("recorded after shutdown"))).toBe(true);
  });

  it("logs how many rows were lost if the database is down at shutdown", async () => {
    const { writer, repository, logs } = setup({ flushIntervalMs: 60_000 });
    repository.failing = true;
    writer.record(row(1));

    await writer.close();

    expect(logs.lines.find((line) => line.msg.includes("before shutdown"))).toMatchObject({
      lost: 1,
    });
  });
});
