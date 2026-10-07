import type { CommitActionEntry } from "./types.js";

export class CommitStatusBroadcaster {
  private currentStatus: string;
  private actions: CommitActionEntry[] = [];
  private modelName: string;
  private startTime: number;
  private totalTokens: number = 0;
  private totalCost: number = 0;
  private subscription: boolean = false;
  private listeners = new Set<() => void>();

  constructor(initialStatus = "Initializing commit agent…", modelName = "") {
    this.currentStatus = initialStatus;
    this.modelName = modelName;
    this.startTime = Date.now();
  }

  get status(): string {
    return this.currentStatus;
  }

  get recentActions(): CommitActionEntry[] {
    return this.actions;
  }

  get model(): string {
    return this.modelName;
  }

  get startTimestamp(): number {
    return this.startTime;
  }

  get tokens(): number {
    return this.totalTokens;
  }

  get cost(): number {
    return this.totalCost;
  }

  get isSubscription(): boolean {
    return this.subscription;
  }

  setModel(name: string): void {
    this.modelName = name;
    this.notify();
  }

  setIsSubscription(val: boolean): void {
    this.subscription = val;
    this.notify();
  }

  update(newStatus: string): void {
    this.currentStatus = newStatus;
    this.notify();
  }

  addAction(action: Omit<CommitActionEntry, "timestamp">): void {
    this.actions.push({ ...action, timestamp: Date.now() });
    this.notify();
  }

  updateUsage(tokens: number, cost: number): void {
    this.totalTokens = tokens;
    this.totalCost = cost;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
