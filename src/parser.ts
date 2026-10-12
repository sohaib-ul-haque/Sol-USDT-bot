import { ParsedTransactionWithMeta } from "@solana/web3.js";
import { OFFICIAL_TOKENS, TokenSymbol } from "./config";
import { formatRawAmount } from "./balance";

export type MovementDirection = "INFLOW" | "OUTFLOW";

export interface TokenMovement {
  movementId: string;
  signature: string;
  symbol: TokenSymbol;
  mint: string;
  direction: MovementDirection;
  amountRaw: string;
  amount: string;
  fromOwner: string;
  toOwner: string;
  txFrom: string;
  slot: number;
  blockTime: number | null;
}

interface TokenBalanceRecord {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: {
    amount: string;
    decimals: number;
  };
}

interface AccountDelta {
  owner: string | null;
  delta: bigint;
}

const UNKNOWN_OWNER = "Unknown / unresolved";

function accountKeys(transaction: ParsedTransactionWithMeta): string[] {
  const keys = transaction.transaction.message.accountKeys.map((entry) =>
    entry.pubkey.toBase58()
  );
  const loaded = transaction.meta?.loadedAddresses;
  if (loaded) {
    keys.push(...loaded.writable.map((key) => key.toBase58()));
    keys.push(...loaded.readonly.map((key) => key.toBase58()));
  }
  return keys;
}

function tokenForMint(mint: string): (typeof OFFICIAL_TOKENS)[TokenSymbol] | null {
  if (mint === OFFICIAL_TOKENS.USDC.mint) return OFFICIAL_TOKENS.USDC;
  if (mint === OFFICIAL_TOKENS.USDT.mint) return OFFICIAL_TOKENS.USDT;
  return null;
}

function symbolForMint(mint: string): TokenSymbol | null {
  if (mint === OFFICIAL_TOKENS.USDC.mint) return "USDC";
  if (mint === OFFICIAL_TOKENS.USDT.mint) return "USDT";
  return null;
}

function parseRawAmount(value: string): bigint {
  if (!/^\d+$/.test(value)) throw new Error("Transaction contains an invalid token amount");
  return BigInt(value);
}

export function parseTokenMovements(
  transaction: ParsedTransactionWithMeta,
  signature: string,
  monitoredWallet: string,
  monitoredTokenAccounts: ReadonlySet<string>
): TokenMovement[] {
  const meta = transaction.meta;
  if (!meta) throw new Error("Transaction metadata is missing");
  if (meta.err) return [];

  const keys = accountKeys(transaction);
  const preBalances = (meta.preTokenBalances ?? []) as TokenBalanceRecord[];
  const postBalances = (meta.postTokenBalances ?? []) as TokenBalanceRecord[];
  const records = new Map<string, { pre?: TokenBalanceRecord; post?: TokenBalanceRecord }>();

  for (const [side, balances] of [
    ["pre", preBalances],
    ["post", postBalances],
  ] as const) {
    for (const balance of balances) {
      if (!tokenForMint(balance.mint)) continue;
      const key = `${balance.accountIndex}:${balance.mint}`;
      const existing = records.get(key) ?? {};
      existing[side] = balance;
      records.set(key, existing);
    }
  }

  const deltasByMint = new Map<string, AccountDelta[]>();
  for (const { pre, post } of records.values()) {
    const record = post ?? pre;
    if (!record) continue;
    const token = tokenForMint(record.mint);
    if (!token) continue;
    if (
      (pre && pre.uiTokenAmount.decimals !== token.decimals) ||
      (post && post.uiTokenAmount.decimals !== token.decimals)
    ) {
      throw new Error(`Unexpected decimals for official ${token.symbol}`);
    }

    const accountAddress = keys[record.accountIndex];
    let owner = post?.owner ?? pre?.owner ?? null;
    if (accountAddress && monitoredTokenAccounts.has(accountAddress)) {
      owner = monitoredWallet;
    }
    const preRaw = pre ? parseRawAmount(pre.uiTokenAmount.amount) : 0n;
    const postRaw = post ? parseRawAmount(post.uiTokenAmount.amount) : 0n;
    const delta = postRaw - preRaw;
    if (delta === 0n) continue;

    const entries = deltasByMint.get(record.mint) ?? [];
    entries.push({ owner, delta });
    deltasByMint.set(record.mint, entries);
  }

  const movements: TokenMovement[] = [];
  for (const [mint, accountDeltas] of deltasByMint) {
    const symbol = symbolForMint(mint);
    if (!symbol) continue;
    const token = OFFICIAL_TOKENS[symbol];
    const ownerDeltas = new Map<string, bigint>();
    let monitoredDelta = 0n;

    for (const entry of accountDeltas) {
      if (entry.owner === monitoredWallet) monitoredDelta += entry.delta;
      if (entry.owner) {
        ownerDeltas.set(entry.owner, (ownerDeltas.get(entry.owner) ?? 0n) + entry.delta);
      }
    }
    if (monitoredDelta === 0n) continue;

    const direction: MovementDirection = monitoredDelta > 0n ? "INFLOW" : "OUTFLOW";
    const counterparties = [...ownerDeltas.entries()].filter(
      ([owner, delta]) =>
        owner !== monitoredWallet &&
        (direction === "INFLOW" ? delta < 0n : delta > 0n)
    );
    const counterparty = counterparties.length === 1 ? counterparties[0]?.[0] : null;
    const absoluteAmount = monitoredDelta < 0n ? -monitoredDelta : monitoredDelta;

    movements.push({
      movementId: `${signature}:${mint}:${direction}`,
      signature,
      symbol,
      mint,
      direction,
      amountRaw: absoluteAmount.toString(),
      amount: formatRawAmount(absoluteAmount, token.decimals),
      fromOwner: direction === "INFLOW" ? counterparty ?? UNKNOWN_OWNER : monitoredWallet,
      toOwner: direction === "OUTFLOW" ? counterparty ?? UNKNOWN_OWNER : monitoredWallet,
      txFrom: keys[0] ?? UNKNOWN_OWNER,
      slot: transaction.slot,
      blockTime: transaction.blockTime ?? null,
    });
  }

  return movements;
}
