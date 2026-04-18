export async function mapLimit<TInput, TOutput>(
  items: TInput[],
  limit: number,
  task: (item: TInput) => Promise<TOutput>,
): Promise<TOutput[]> {
  const results = Array.from({ length: items.length }) as TOutput[];
  let index = 0;

  async function worker(): Promise<void> {
    while (true) {
      const current = index;
      index += 1;
      if (current >= items.length) {
        return;
      }
      results[current] = await task(items[current]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker()),
  );
  return results;
}
