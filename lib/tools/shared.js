// Claude caps one tool result at about 150,000 characters on claude.ai and
// 25,000 tokens in Claude Code, and past that cuts it short without saying
// what was lost. A result over this limit is refused instead, with a message
// that says how to ask for less.
export const MAX_RESULT_CHARS = 100_000;

// Compact JSON: indentation costs a third to a half more context and tells
// Claude nothing it can't read from the compact form.
export function asJson(value) {
  const text = JSON.stringify(value);
  if (text.length > MAX_RESULT_CHARS) {
    throw new Error(
      `This answer is ${text.length.toLocaleString('en-GB')} characters, over the ${MAX_RESULT_CHARS.toLocaleString('en-GB')} ` +
      'this server returns at once. Ask for less: a shorter days/weeks window or a smaller limit.'
    );
  }
  return { content: [{ type: 'text', text }] };
}

// SparkyFitness has no date-range endpoint for several per-day-only
// resources (exercise entries, daily nutrition summaries), so a multi-day
// window means one request per day. Capped rather than fully parallel — a
// 90-day max window would otherwise fire 90 concurrent requests at once.
// Shared across every tool that fans out one request per day in a window.
export const DEFAULT_FETCH_CONCURRENCY = 10;

export async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
