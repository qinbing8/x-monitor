export async function mapWithConcurrency(items, concurrency, worker) {
  const safeItems = Array.isArray(items) ? items : [];
  const safeConcurrency = Math.max(1, Number(concurrency ?? 1) || 1);
  // Execute each window in parallel while preserving the original order.
  const results = new Array(safeItems.length);

  for (let offset = 0; offset < safeItems.length; offset += safeConcurrency) {
    const window = safeItems.slice(offset, offset + safeConcurrency);
    const windowResults = await Promise.all(
      window.map((item, index) => worker(item, offset + index)),
    );
    for (let index = 0; index < windowResults.length; index += 1) {
      results[offset + index] = windowResults[index];
    }
  }

  return results;
}
