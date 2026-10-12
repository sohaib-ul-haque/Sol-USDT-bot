import WebSocket from "ws";
import { NamedEndpoint } from "./config";

export interface ActivityEvent {
  signature?: string;
  account?: string;
  slot?: number;
}

type SubscriptionRequest =
  | { type: "logs" }
  | { type: "slot" }
  | { type: "account"; account: string };

export class SolanaWebSocket {
  private socket: WebSocket | null = null;
  private providerIndex = 0;
  private reconnectDelayMs = 1_000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private connectionTimer: NodeJS.Timeout | null = null;
  private generation = 0;
  private stopped = true;
  private nextRequestId = 1;
  private readonly tokenAccounts = new Set<string>();
  private readonly requestedAccounts = new Set<string>();
  private readonly pendingRequests = new Map<number, SubscriptionRequest>();
  private readonly subscriptions = new Map<number, SubscriptionRequest>();

  constructor(
    private readonly providers: NamedEndpoint[],
    private readonly monitoredWallet: string,
    private readonly onActivity: (event: ActivityEvent) => void,
    private readonly onConnected: (providerName: string) => Promise<void>,
    private readonly onSlot: (slot: number) => void
  ) {
    if (providers.length !== 2) {
      throw new Error("Exactly two WebSocket providers are required");
    }
  }

  start(accounts: Iterable<string>): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.updateTokenAccounts(accounts);
    this.connect();
  }

  updateTokenAccounts(accounts: Iterable<string>): void {
    for (const account of accounts) this.tokenAccounts.add(account);
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.subscribeMissingAccounts();
    }
  }

  stop(): void {
    this.stopped = true;
    this.generation += 1;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) {
      socket.close(1000, "shutdown");
    }
  }

  private connect(): void {
    if (this.stopped) return;
    this.clearTimers();
    this.pendingRequests.clear();
    this.subscriptions.clear();
    this.requestedAccounts.clear();

    const provider = this.providers[this.providerIndex];
    if (!provider) throw new Error("WebSocket provider configuration is empty");
    const generation = ++this.generation;
    const socket = new WebSocket(provider.url, { handshakeTimeout: 10_000 });
    this.socket = socket;
    let alive = true;

    this.connectionTimer = setTimeout(() => {
      if (socket.readyState !== WebSocket.OPEN) socket.terminate();
    }, 12_000);

    socket.on("open", () => {
      if (generation !== this.generation || this.stopped) {
        socket.close();
        return;
      }
      if (this.connectionTimer) clearTimeout(this.connectionTimer);
      this.connectionTimer = null;
      this.reconnectDelayMs = 1_000;
      console.log(`[WSS] Connected to ${provider.name}`);
      this.sendSubscription("logsSubscribe", [
        { mentions: [this.monitoredWallet] },
        { commitment: "confirmed" },
      ], { type: "logs" });
      this.sendSubscription("slotSubscribe", [], { type: "slot" });
      this.subscribeMissingAccounts();

      this.heartbeatTimer = setInterval(() => {
        if (!alive) {
          socket.terminate();
          return;
        }
        alive = false;
        socket.ping();
      }, 30_000);

      void this.onConnected(provider.name).catch(() => {
        console.warn("[RECOVERY] Catch-up after WebSocket connection failed; retry retained");
      });
    });

    socket.on("pong", () => {
      alive = true;
    });

    socket.on("message", (data) => {
      if (generation !== this.generation || this.stopped) return;
      this.handleMessage(data.toString());
    });

    socket.on("error", () => {
      console.warn(`[WSS] ${provider.name} connection error`);
    });

    socket.on("close", () => {
      if (generation !== this.generation || this.stopped) return;
      this.clearTimers();
      this.socket = null;
      const previous = provider.name;
      this.providerIndex = (this.providerIndex + 1) % this.providers.length;
      const next = this.providers[this.providerIndex];
      console.warn(
        `[WSS] ${previous} disconnected; failing over to ${next?.name ?? "backup"}`
      );
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private subscribeMissingAccounts(): void {
    for (const account of this.tokenAccounts) {
      if (this.requestedAccounts.has(account)) continue;
      this.requestedAccounts.add(account);
      this.sendSubscription(
        "accountSubscribe",
        [account, { commitment: "confirmed", encoding: "base64" }],
        { type: "account", account }
      );
    }
  }

  private sendSubscription(method: string, params: unknown[], request: SubscriptionRequest): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    const id = this.nextRequestId++;
    this.pendingRequests.set(id, request);
    this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  }

  private handleMessage(raw: string): void {
    let message: unknown;
    try {
      message = JSON.parse(raw) as unknown;
    } catch {
      console.warn("[WSS] Ignoring malformed JSON message");
      return;
    }
    if (!message || typeof message !== "object") return;
    const value = message as {
      id?: unknown;
      result?: unknown;
      error?: unknown;
      method?: unknown;
      params?: {
        subscription?: unknown;
        result?: { context?: { slot?: unknown }; value?: unknown; slot?: unknown };
      };
    };

    if (typeof value.id === "number") {
      const request = this.pendingRequests.get(value.id);
      this.pendingRequests.delete(value.id);
      if (!request) return;
      if (value.error || typeof value.result !== "number") {
        if (request.type === "account") this.requestedAccounts.delete(request.account);
        console.warn("[WSS] Subscription failed; reconnecting through failover");
        this.socket?.close();
        return;
      }
      this.subscriptions.set(value.result, request);
      return;
    }

    const subscriptionId = value.params?.subscription;
    if (typeof subscriptionId !== "number") return;
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return;

    if (subscription.type === "slot") {
      const liveSlot = value.params?.result?.slot;
      if (typeof liveSlot === "number") this.onSlot(liveSlot);
      return;
    }

    const slotValue = value.params?.result?.context?.slot;
    const slot = typeof slotValue === "number" ? slotValue : undefined;

    if (subscription.type === "account") {
      this.onActivity({ account: subscription.account, slot });
      return;
    }

    const notification = value.params?.result?.value as
      | { signature?: unknown; err?: unknown }
      | undefined;
    if (notification?.err) return;
    if (typeof notification?.signature === "string") {
      this.onActivity({ signature: notification.signature, slot });
    }
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.connectionTimer) clearTimeout(this.connectionTimer);
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.connectionTimer = null;
  }
}
