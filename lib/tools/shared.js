export function asJson(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
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
