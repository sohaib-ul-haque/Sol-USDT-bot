import "dotenv/config";
import { PublicKey } from "@solana/web3.js";

export interface NamedEndpoint {
  name: string;
  url: string;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function endpoint(name: string, protocol: "http" | "ws"): string {
  const value = required(name);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }

  const allowed = protocol === "http" ? ["http:", "https:"] : ["ws:", "wss:"];
  if (!allowed.includes(parsed.protocol)) {
    throw new Error(`${name} must use ${allowed.join(" or ")}`);
  }
  return value;
}

function publicKey(name: string, value: string): PublicKey {
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(`${name} must be a valid Solana public key`);
  }
}

export const OFFICIAL_TOKENS = {
  USDC: {
    symbol: "USDC",
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    decimals: 6,
  },
  USDT: {
    symbol: "USDT",
    mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    decimals: 6,
  },
} as const;

export type TokenSymbol = keyof typeof OFFICIAL_TOKENS;

for (const token of Object.values(OFFICIAL_TOKENS)) {
  publicKey(`${token.symbol} mint`, token.mint);
}

const monitoredWallet = required("MONITORED_WALLET");
const monitoredWalletPublicKey = publicKey("MONITORED_WALLET", monitoredWallet);
const telegramChatIds = [
  ...new Set(
    required("TELEGRAM_CHAT_ID")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0)
  ),
];
if (telegramChatIds.length === 0 || !telegramChatIds.every((id) => /^-?\d+$/.test(id))) {
  throw new Error("TELEGRAM_CHAT_ID must be one or more comma-separated numeric chat IDs");
}

export const config = {
  telegram: {
    token: required("TELEGRAM_BOT_TOKEN"),
    chatIds: telegramChatIds,
  },
  wallet: {
    address: monitoredWallet,
    publicKey: monitoredWalletPublicKey,
    label: required("MONITORED_WALLET_LABEL"),
  },
  rpc: {
    http: [
      { name: "Helius", url: endpoint("SOLANA_RPC_HELIUS", "http") },
      { name: "Alchemy", url: endpoint("SOLANA_RPC_ALCHEMY", "http") },
      { name: "Chainstack", url: endpoint("SOLANA_RPC_CHAINSTACK", "http") },
    ] satisfies NamedEndpoint[],
    websocket: [
      { name: "Alchemy", url: endpoint("SOLANA_WSS_ALCHEMY", "ws") },
      { name: "Chainstack", url: endpoint("SOLANA_WSS_CHAINSTACK", "ws") },
    ] satisfies NamedEndpoint[],
    timeoutMs: 12_000,
    providerCooldownMs: 30_000,
  },
  monitor: {
    discoveryIntervalMs: 5 * 60_000,
    activityDebounceMs: 750,
    slotLogEvery: 1,
    syncCheckIntervalMs: 30_000,
    maxSlotLag: 10,
    failedRecoveryRetryMs: 15_000,
    recoveryPageSize: 100,
    maxRecoveryPagesPerAddress: 10,
    maxRecoverySignatures: 1_000,
    maxRecentSignatures: 500,
    maxRecentMovementIds: 1_000,
  },
};
