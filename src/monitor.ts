import { ConfirmedSignatureInfo, PublicKey } from "@solana/web3.js";
import { config, OFFICIAL_TOKENS, TokenSymbol } from "./config";
import { parseTokenMovements } from "./parser";
import { RpcPool } from "./rpc";
import { StateStore } from "./state";
import { TelegramService } from "./telegram";
import { ActivityEvent, SolanaWebSocket } from "./websocket";

export class WalletMonitor {
  private readonly accountsByToken: Record<TokenSymbol, Set<string>> = {
    USDC: new Set<string>(),
    USDT: new Set<string>(),
  };
  private readonly deliveredMovementIds = new Set<string>();
  private websocket: SolanaWebSocket | null = null;
  private stateLoaded = false;
  private stopping = false;
  private discoveryTimer: NodeJS.Timeout | null = null;
  private syncTimer: NodeJS.Timeout | null = null;
  private liveSlot: number | null = null;
  private lastSlotAt = 0;
  private slotsSeen = 0;
  private activityTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private recoveryPromise: Promise<void> | null = null;

  constructor(
    private readonly rpc: RpcPool,
    private readonly telegram: TelegramService,
    private readonly state: StateStore
  ) {}

  async start(): Promise<void> {
    await this.discoverTokenAccounts();
    await this.state.load();
    this.stateLoaded = true;
    await this.state.addTrackedTokenAccounts(this.currentTokenAccounts());

    const state = this.state.snapshot();
    if (!state.initialized) {
      await this.establishFreshBaseline();
    } else {
      try {
        await this.performRecovery("startup");
      } catch {
        console.warn("[RECOVERY] Startup catch-up incomplete; retry scheduled");
        this.scheduleRecoveryRetry();
      }
    }

    this.websocket = new SolanaWebSocket(
      config.rpc.websocket,
      config.wallet.address,
      (event) => this.handleActivity(event),
      async (providerName) => {
        if (this.stopping) return;
        await this.refreshAfterReconnect(providerName);
      },
      (slot) => this.handleSlot(slot)
    );
    this.websocket.start(this.currentTokenAccounts());
    this.discoveryTimer = setInterval(() => {
      void this.refreshDiscovery();
    }, config.monitor.discoveryIntervalMs);
    this.syncTimer = setInterval(() => {
      void this.checkSync();
    }, config.monitor.syncCheckIntervalMs);
    console.log("[MONITOR] Live monitoring initialized");
  }

  private handleSlot(slot: number): void {
    this.liveSlot = slot;
    this.lastSlotAt = Date.now();
    this.slotsSeen += 1;
    if (this.slotsSeen % config.monitor.slotLogEvery === 0) {
      console.log(`[BLOCK] Live slot ${slot}`);
    }
  }

  private async checkSync(): Promise<void> {
    if (this.stopping) return;
    try {
      const rpcSlot = await this.rpc.getSlot();
      if (this.liveSlot === null || Date.now() - this.lastSlotAt > 10_000) {
        console.warn(`[SYNC] No live slots from WebSocket (RPC slot ${rpcSlot}) - NOT SYNCED`);
        return;
      }
      const behind = rpcSlot - this.liveSlot;
      const status = behind > config.monitor.maxSlotLag ? "LAGGING" : "SYNCED";
      console.log(
        `[SYNC] ${status} | ws slot ${this.liveSlot} | rpc slot ${rpcSlot} | behind ${behind}`
      );
    } catch {
      console.warn("[SYNC] RPC slot check failed");
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = null;
    if (this.activityTimer) clearTimeout(this.activityTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.discoveryTimer = null;
    this.activityTimer = null;
    this.retryTimer = null;
    this.websocket?.stop();
    this.websocket = null;
    if (this.recoveryPromise) {
      await this.recoveryPromise.catch(() => undefined);
    }
  }

  private async establishFreshBaseline(): Promise<void> {
    const slot = await this.rpc.getSlot();
    const latest = await this.findLatestKnownSignature();
    await this.state.initializeBaseline(slot, latest?.signature ?? null);
    console.log(`[STATE] Fresh baseline established at slot ${slot}; historical alerts skipped`);
  }

  private async discoverTokenAccounts(): Promise<void> {
    const next: Record<TokenSymbol, Set<string>> = {
      USDC: new Set<string>(),
      USDT: new Set<string>(),
    };

    for (const symbol of ["USDC", "USDT"] as const) {
      const token = OFFICIAL_TOKENS[symbol];
      const accounts = await this.rpc.getOwnedTokenAccounts(
        config.wallet.publicKey,
        new PublicKey(token.mint)
      );
      for (const account of accounts) {
        if (account.mint === token.mint && account.owner === config.wallet.address) {
          next[symbol].add(account.address);
        }
      }
    }

    this.accountsByToken.USDC = next.USDC;
    this.accountsByToken.USDT = next.USDT;
    console.log(
      `[MONITOR] Watching ${next.USDC.size} USDC account(s), ${next.USDT.size} USDT account(s)`
    );
  }

  private async refreshDiscovery(): Promise<void> {
    if (this.stopping) return;
    try {
      await this.discoverTokenAccounts();
      if (this.stateLoaded) {
        await this.state.addTrackedTokenAccounts(this.currentTokenAccounts());
      }
      this.websocket?.updateTokenAccounts(this.currentTokenAccounts());
    } catch {
      console.warn("[MONITOR] Token-account refresh failed; existing subscriptions retained");
    }
  }

  private async refreshAfterReconnect(providerName: string): Promise<void> {
    console.log(`[RECOVERY] Catch-up started after ${providerName} connection`);
    await this.refreshDiscovery();
    await this.performRecovery("reconnect");
  }

  private handleActivity(_event: ActivityEvent): void {
    if (this.stopping) return;
    if (this.activityTimer) clearTimeout(this.activityTimer);
    this.activityTimer = setTimeout(() => {
      this.activityTimer = null;
      void this.performRecovery("live activity").catch(() => {
        console.warn("[RECOVERY] Live catch-up incomplete; retry scheduled");
        this.scheduleRecoveryRetry();
      });
    }, config.monitor.activityDebounceMs);
  }

  private async performRecovery(reason: string): Promise<void> {
    if (this.recoveryPromise) return this.recoveryPromise;
    const operation = this.runRecovery(reason);
    this.recoveryPromise = operation;
    try {
      await operation;
    } finally {
      if (this.recoveryPromise === operation) this.recoveryPromise = null;
    }
  }

  private async runRecovery(reason: string): Promise<void> {
    if (this.stopping) return;
    const snapshot = this.state.snapshot();
    if (!snapshot.initialized || snapshot.lastProcessedSlot === null) {
      throw new Error("Recovery requested without an initialized checkpoint");
    }
    console.log(`[RECOVERY] Catch-up started (${reason})`);
    const candidates = await this.collectRecoverySignatures(snapshot.lastProcessedSlot);

    for (const candidate of candidates) {
      if (this.stopping) return;
      if (this.state.isSignatureProcessed(candidate.signature)) continue;
      await this.processSignature(candidate);
    }
    console.log("[RECOVERY] Catch-up complete");
  }

  private async collectRecoverySignatures(
    checkpointSlot: number
  ): Promise<ConfirmedSignatureInfo[]> {
    const candidates = new Map<string, ConfirmedSignatureInfo>();
    const addresses = this.recoveryAddresses();

    for (const address of addresses) {
      let before: string | undefined;
      let reachedCheckpoint = false;

      for (
        let pageNumber = 0;
        pageNumber < config.monitor.maxRecoveryPagesPerAddress;
        pageNumber += 1
      ) {
        const page = await this.rpc.getSignaturesForAddress(new PublicKey(address), {
          before,
          limit: config.monitor.recoveryPageSize,
        });
        if (page.length === 0) {
          reachedCheckpoint = true;
          break;
        }

        for (const signatureInfo of page) {
          if (signatureInfo.slot < checkpointSlot) {
            reachedCheckpoint = true;
            break;
          }
          if (!this.state.isSignatureProcessed(signatureInfo.signature)) {
            candidates.set(signatureInfo.signature, signatureInfo);
            if (candidates.size > config.monitor.maxRecoverySignatures) {
              throw new Error("Recovery window exceeds configured safety bound");
            }
          }
        }
        if (reachedCheckpoint || page.length < config.monitor.recoveryPageSize) {
          reachedCheckpoint = true;
          break;
        }
        before = page[page.length - 1]?.signature;
        if (!before) break;
      }

      if (!reachedCheckpoint) {
        throw new Error(`Recovery pagination bound reached for monitored address`);
      }
    }

    return [...candidates.values()].sort(
      (left, right) => left.slot - right.slot || left.signature.localeCompare(right.signature)
    );
  }

  private async processSignature(signatureInfo: ConfirmedSignatureInfo): Promise<void> {
    const shortSignature = `${signatureInfo.signature.slice(0, 8)}…${signatureInfo.signature.slice(-6)}`;
    console.log(`[TX] Processing ${shortSignature}`);
    const transaction = await this.rpc.getParsedTransaction(signatureInfo.signature);
    const movements = parseTokenMovements(
      transaction,
      signatureInfo.signature,
      config.wallet.address,
      new Set(this.state.snapshot().trackedTokenAccounts)
    );

    for (const movement of movements) {
      if (
        this.state.isMovementProcessed(movement.movementId) ||
        this.deliveredMovementIds.has(movement.movementId)
      ) {
        continue;
      }
      await this.telegram.sendMovement(movement);
      this.deliveredMovementIds.add(movement.movementId);
      await this.state.markMovementProcessed(movement.movementId);
      this.deliveredMovementIds.delete(movement.movementId);
    }

    await this.state.markSignatureProcessed(signatureInfo.signature, signatureInfo.slot);
  }

  private async findLatestKnownSignature(): Promise<ConfirmedSignatureInfo | null> {
    let latest: ConfirmedSignatureInfo | null = null;
    for (const address of this.recoveryAddresses(false)) {
      const [candidate] = await this.rpc.getSignaturesForAddress(new PublicKey(address), {
        limit: 1,
      });
      if (candidate && (!latest || candidate.slot > latest.slot)) latest = candidate;
    }
    return latest;
  }

  private currentTokenAccounts(): string[] {
    return [...this.accountsByToken.USDC, ...this.accountsByToken.USDT];
  }

  private recoveryAddresses(includeStored = true): string[] {
    const addresses = new Set<string>([config.wallet.address, ...this.currentTokenAccounts()]);
    if (includeStored && this.stateLoaded) {
      for (const account of this.state.snapshot().trackedTokenAccounts) addresses.add(account);
    }
    return [...addresses];
  }

  private scheduleRecoveryRetry(): void {
    if (this.stopping || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.performRecovery("retry").catch(() => {
        console.warn("[RECOVERY] Retry failed; checkpoint retained");
        this.scheduleRecoveryRetry();
      });
    }, config.monitor.failedRecoveryRetryMs);
  }
}
