import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface MonitorState {
  version: 1;
  initialized: boolean;
  lastProcessedSignature: string | null;
  lastProcessedSlot: number | null;
  recentSignatures: string[];
  recentMovementIds: string[];
  trackedTokenAccounts: string[];
}

const EMPTY_STATE: MonitorState = {
  version: 1,
  initialized: false,
  lastProcessedSignature: null,
  lastProcessedSlot: null,
  recentSignatures: [],
  recentMovementIds: [],
  trackedTokenAccounts: [],
};

function validateState(value: unknown): MonitorState {
  if (!value || typeof value !== "object") {
    throw new Error("State file must contain a JSON object");
  }
  const state = value as Partial<MonitorState>;
  const lastProcessedSlot = state.lastProcessedSlot;
  if (
    state.version !== 1 ||
    typeof state.initialized !== "boolean" ||
    (state.lastProcessedSignature !== null &&
      typeof state.lastProcessedSignature !== "string") ||
    (lastProcessedSlot !== null && typeof lastProcessedSlot !== "number") ||
    (typeof lastProcessedSlot === "number" &&
      (!Number.isSafeInteger(lastProcessedSlot) || lastProcessedSlot < 0)) ||
    !Array.isArray(state.recentSignatures) ||
    !state.recentSignatures.every((item) => typeof item === "string") ||
    !Array.isArray(state.recentMovementIds) ||
    !state.recentMovementIds.every((item) => typeof item === "string") ||
    !Array.isArray(state.trackedTokenAccounts) ||
    !state.trackedTokenAccounts.every((item) => typeof item === "string")
  ) {
    throw new Error("State file has an invalid structure");
  }
  return {
    version: 1,
    initialized: state.initialized,
    lastProcessedSignature: state.lastProcessedSignature,
    lastProcessedSlot: lastProcessedSlot as number | null,
    recentSignatures: [...state.recentSignatures],
    recentMovementIds: [...state.recentMovementIds],
    trackedTokenAccounts: [...state.trackedTokenAccounts],
  };
}

function appendBounded(items: string[], item: string, limit: number): string[] {
  const next = items.filter((existing) => existing !== item);
  next.push(item);
  return next.slice(-limit);
}

export class StateStore {
  private state: MonitorState = { ...EMPTY_STATE };

  constructor(
    private readonly filePath: string,
    private readonly maxRecentSignatures: number,
    private readonly maxRecentMovementIds: number
  ) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      this.state = validateState(JSON.parse(raw) as unknown);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        await this.persist({ ...EMPTY_STATE });
        return;
      }
      if (error instanceof SyntaxError) {
        throw new Error(`State file is malformed; refusing to discard it: ${this.filePath}`);
      }
      throw error;
    }
  }

  snapshot(): MonitorState {
    return {
      ...this.state,
      recentSignatures: [...this.state.recentSignatures],
      recentMovementIds: [...this.state.recentMovementIds],
      trackedTokenAccounts: [...this.state.trackedTokenAccounts],
    };
  }

  isSignatureProcessed(signature: string): boolean {
    return this.state.recentSignatures.includes(signature);
  }

  isMovementProcessed(movementId: string): boolean {
    return this.state.recentMovementIds.includes(movementId);
  }

  async initializeBaseline(slot: number, signature: string | null): Promise<void> {
    if (this.state.initialized) return;
    const next: MonitorState = {
      ...this.snapshot(),
      initialized: true,
      lastProcessedSlot: slot,
      lastProcessedSignature: signature,
      recentSignatures: signature ? [signature] : [],
    };
    await this.persist(next);
  }

  async addTrackedTokenAccounts(addresses: Iterable<string>): Promise<void> {
    const merged = new Set(this.state.trackedTokenAccounts);
    for (const address of addresses) merged.add(address);
    const next = { ...this.snapshot(), trackedTokenAccounts: [...merged] };
    await this.persist(next);
  }

  async markMovementProcessed(movementId: string): Promise<void> {
    const next = {
      ...this.snapshot(),
      recentMovementIds: appendBounded(
        this.state.recentMovementIds,
        movementId,
        this.maxRecentMovementIds
      ),
    };
    await this.persist(next);
  }

  async markSignatureProcessed(signature: string, slot: number): Promise<void> {
    const next: MonitorState = {
      ...this.snapshot(),
      lastProcessedSignature: signature,
      lastProcessedSlot:
        this.state.lastProcessedSlot === null
          ? slot
          : Math.max(this.state.lastProcessedSlot, slot),
      recentSignatures: appendBounded(
        this.state.recentSignatures,
        signature,
        this.maxRecentSignatures
      ),
    };
    await this.persist(next);
  }

  private async persist(next: MonitorState): Promise<void> {
    const directory = path.dirname(this.filePath);
    const temporaryPath = `${this.filePath}.tmp`;
    await mkdir(directory, { recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
    this.state = next;
  }
}
