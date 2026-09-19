// Binary min-heap of (key, item) with insertion order as the tie-break, so
// pops are deterministic. A max-heap is a min-heap on −key.
export class KeyedHeap<T> {
  private keys: number[] = [];
  private ids: number[] = [];
  private items: T[] = [];
  private nextId = 0;

  get size(): number { return this.items.length; }

  push(key: number, item: T): void {
    this.keys.push(key);
    this.ids.push(this.nextId++);
    this.items.push(item);
    this.up(this.items.length - 1);
  }

  peekKey(): number {
    return this.items.length === 0 ? Infinity : this.keys[0]!;
  }

  pop(): T | undefined {
    const n = this.items.length;
    if (n === 0) return undefined;
    const top = this.items[0]!;
    this.swap(0, n - 1);
    this.keys.pop();
    this.ids.pop();
    this.items.pop();
    this.down(0);
    return top;
  }

  private less(a: number, b: number): boolean {
    return this.keys[a]! < this.keys[b]! || (this.keys[a] === this.keys[b] && this.ids[a]! < this.ids[b]!);
  }

  private swap(a: number, b: number): void {
    [this.keys[a], this.keys[b]] = [this.keys[b]!, this.keys[a]!];
    [this.ids[a], this.ids[b]] = [this.ids[b]!, this.ids[a]!];
    [this.items[a], this.items[b]] = [this.items[b]!, this.items[a]!];
  }

  private up(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(i, parent)) return;
      this.swap(i, parent);
      i = parent;
    }
  }

  private down(i: number): void {
    const n = this.items.length;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < n && this.less(l, m)) m = l;
      if (r < n && this.less(r, m)) m = r;
      if (m === i) return;
      this.swap(i, m);
      i = m;
    }
  }
}
