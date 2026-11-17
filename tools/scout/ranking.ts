/** Stable, bounded best-K selection. compare(a,b) < 0 means a ranks first. */
export class TopK<T> {
  private heap: Array<{ value: T; order: number }> = [];
  private nextOrder = 0;
  constructor(private readonly capacity: number, private readonly compare: (a: T, b: T) => number) {}

  private compareEntries(a: { value: T; order: number }, b: { value: T; order: number }): number {
    return this.compare(a.value, b.value) || a.order - b.order;
  }

  public add(value: T): void {
    const entry = { value, order: this.nextOrder++ };
    if (this.capacity <= 0) return;
    const heap = this.heap;
    if (heap.length < this.capacity) {
      heap.push(entry);
      let i = heap.length - 1;
      while (i > 0) {
        const parent = (i - 1) >>> 1;
        if (this.compareEntries(heap[i], heap[parent]) <= 0) break;
        [heap[i], heap[parent]] = [heap[parent], heap[i]];
        i = parent;
      }
    } else if (this.compareEntries(entry, heap[0]) < 0) {
      heap[0] = entry;
      let i = 0;
      while (i * 2 + 1 < heap.length) {
        let child = i * 2 + 1;
        if (child + 1 < heap.length && this.compareEntries(heap[child + 1], heap[child]) > 0) child++;
        if (this.compareEntries(heap[i], heap[child]) >= 0) break;
        [heap[i], heap[child]] = [heap[child], heap[i]];
        i = child;
      }
    }
  }

  public sorted(): T[] {
    return [...this.heap].sort((a, b) => this.compareEntries(a, b)).map((entry) => entry.value);
  }
}

/** Rank only the first batch eagerly. Sort the remainder only if consumed. */
export function* rankFirstBatch<T>(values: readonly T[], compare: (a: T, b: T) => number, size = 64): Generator<T> {
  if (values.length <= size * 2) {
    yield* [...values].sort(compare);
    return;
  }
  const first = new TopK<number>(size, (a, b) => compare(values[a], values[b]));
  for (let i = 0; i < values.length; i++) first.add(i);
  const indices = first.sorted();
  for (const i of indices) yield values[i];
  const selected = new Set(indices);
  yield* values.filter((_value, i) => !selected.has(i)).sort(compare);
}
