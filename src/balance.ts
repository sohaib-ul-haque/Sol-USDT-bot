import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { OFFICIAL_TOKENS } from "./config";
import { RpcPool } from "./rpc";

export interface WalletBalances {
  sol: string;
  usdc: string;
  usdt: string;
}

export function formatRawAmount(raw: bigint, decimals: number): string {
  if (raw < 0n) throw new Error("Balance cannot be negative");
  if (!Number.isSafeInteger(decimals) || decimals < 0) {
    throw new Error("Invalid token decimals");
  }
  if (decimals === 0) return raw.toString();

  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const fraction = (raw % scale)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export class BalanceService {
  constructor(
    private readonly rpc: RpcPool,
    private readonly wallet: PublicKey
  ) {}

  async getCurrentBalances(): Promise<WalletBalances> {
    const lamports = await this.rpc.getBalance(this.wallet);
    if (!Number.isSafeInteger(lamports) || lamports < 0) {
      throw new Error("RPC returned an unsafe SOL balance");
    }

    const totals: Record<"USDC" | "USDT", bigint> = { USDC: 0n, USDT: 0n };
    for (const symbol of ["USDC", "USDT"] as const) {
      const token = OFFICIAL_TOKENS[symbol];
      const accounts = await this.rpc.getOwnedTokenAccounts(
        this.wallet,
        new PublicKey(token.mint)
      );
      totals[symbol] = accounts.reduce((sum, account) => {
        if (account.mint !== token.mint) return sum;
        return sum + BigInt(account.amountRaw);
      }, 0n);
    }

    return {
      sol: formatRawAmount(BigInt(lamports), Math.log10(LAMPORTS_PER_SOL)),
      usdc: formatRawAmount(totals.USDC, OFFICIAL_TOKENS.USDC.decimals),
      usdt: formatRawAmount(totals.USDT, OFFICIAL_TOKENS.USDT.decimals),
    };
  }
}
