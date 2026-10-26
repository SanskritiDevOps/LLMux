/**
 * Stands in for the usage writer: keeps every recorded row in `rows`, so tests can check
 * exactly what a request would have written to usage_logs. The real writer is covered by
 * usageWriter.test.js and the database tests.
 */
export function fakeUsage() {
  const rows = [];
  return {
    rows,
    record(row) {
      rows.push(row);
    },
    /** The row for one request, waiting briefly because rows are recorded after the response. */
    async rowFor(requestId, { timeoutMs = 3000 } = {}) {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        const row = rows.find((candidate) => candidate.requestId === requestId);
        if (row) return row;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`No usage row for ${requestId} within ${timeoutMs} ms`);
    },
  };
}
