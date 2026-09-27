interface CursorState {
  type: "find" | "grep";
  query: string;
  nextOffset: number;
  options: Record<string, any>;
  createdAt: number;
}

export class CursorStore {
  private static instance: CursorStore | null = null;
  private cursors = new Map<string, CursorState>();
  private counter = 0;

  public static getInstance(): CursorStore {
    if (!CursorStore.instance) {
      CursorStore.instance = new CursorStore();
    }
    return CursorStore.instance;
  }

  public store(type: "find" | "grep", query: string, nextOffset: number, options: Record<string, any>): string {
    const id = `s_c${++this.counter}`;
    this.cursors.set(id, {
      type,
      query,
      nextOffset,
      options,
      createdAt: Date.now(),
    });

    // Keep size bounded to last 100 cursors
    if (this.cursors.size > 100) {
      const first = this.cursors.keys().next().value;
      if (first) this.cursors.delete(first);
    }

    return id;
  }

  public get(id: string): CursorState | undefined {
    return this.cursors.get(id);
  }
}
