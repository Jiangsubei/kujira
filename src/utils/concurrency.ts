/**
 * kujira: 并发控制小工具
 *
 * 用于入站媒体下载等 I/O 密集场景：保持输入顺序返回结果，同时把同时在飞的请求数限制在 `limit` 内，
 * 避免一次性打开过多连接。
 */

export async function mapWithConcurrency<T, R>(
  items: ReadonlyArray<T>,
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];

  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: width }, async () => {
    for (;;) {
      const current = cursor++;
      if (current >= items.length) return;
      results[current] = await worker(items[current]!, current);
    }
  });

  await Promise.all(runners);
  return results;
}
