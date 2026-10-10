import {
  Commitment,
  ConfirmedSignatureInfo,
  Connection,
  Finality,
  ParsedAccountData,
  ParsedTransactionWithMeta,
  PublicKey,
  SignaturesForAddressOptions,
} from "@solana/web3.js";
import { NamedEndpoint } from "./config";

interface RpcProvider {
  name: string;
  connection: Connection;
  cooldownUntil: number;
  readyLogged: boolean;
}

export interface OwnedTokenAccount {
  address: string;
  mint: string;
  owner: string;
  amountRaw: string;
  decimals: number;
}

const COMMITMENT: Commitment = "confirmed";
const FINALITY: Finality = "confirmed";

export class RpcPool {
  private readonly providers: RpcProvider[];

  constructor(
    endpoints: NamedEndpoint[],
    private readonly timeoutMs: number,
    private readonly cooldownMs: number
  ) {
    this.providers = endpoints.map(({ name, url }) => ({
      name,
      connection: new Connection(url, {
        commitment: COMMITMENT,
        disableRetryOnRateLimit: true,
      }),
      cooldownUntil: 0,
      readyLogged: false,
    }));
  }

  private async withTimeout<T>(promise: Promise<T>, operation: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`RPC timeout during ${operation}`)),
            this.timeoutMs
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async request<T>(
    operation: string,
    execute: (connection: Connection) => Promise<T>
  ): Promise<T> {
    const now = Date.now();
    const available = this.providers.filter((provider) => provider.cooldownUntil <= now);
    const candidates = available.length > 0 ? available : this.providers;

    for (let index = 0; index < candidates.length; index += 1) {
      const provider = candidates[index];
      if (!provider) continue;
      try {
        const result = await this.withTimeout(execute(provider.connection), operation);
        provider.cooldownUntil = 0;
        if (!provider.readyLogged) {
          console.log(`[RPC] ${provider.name} ready`);
          provider.readyLogged = true;
        }
        return result;
      } catch {
        provider.cooldownUntil = Date.now() + this.cooldownMs;
        const next = candidates[index + 1];
        if (next) {
          console.warn(`[RPC] ${provider.name} failed during ${operation}; trying ${next.name}`);
        } else {
          console.warn(`[RPC] ${provider.name} failed during ${operation}`);
        }
      }
    }

    throw new Error(`All HTTP RPC providers failed during ${operation}`);
  }

  async getSlot(): Promise<number> {
    return this.request("getSlot", (connection) => connection.getSlot(COMMITMENT));
  }

  async getBalance(address: PublicKey): Promise<number> {
    return this.request("getBalance", (connection) =>
      connection.getBalance(address, COMMITMENT)
    );
  }

  async getOwnedTokenAccounts(owner: PublicKey, mint: PublicKey): Promise<OwnedTokenAccount[]> {
    return this.request("getTokenAccountsByOwner", async (connection) => {
      const response = await connection.getParsedTokenAccountsByOwner(
        owner,
        { mint },
        COMMITMENT
      );

      return response.value.map(({ pubkey, account }) => {
        if (!("parsed" in account.data)) {
          throw new Error("RPC returned an unparsed token account");
        }
        const parsed = account.data as ParsedAccountData;
        const info = parsed.parsed?.info as
          | {
              mint?: string;
              owner?: string;
              tokenAmount?: { amount?: string; decimals?: number };
            }
          | undefined;
        const amount = info?.tokenAmount?.amount;
        const decimals = info?.tokenAmount?.decimals;
        if (
          typeof info?.mint !== "string" ||
          typeof info.owner !== "string" ||
          typeof amount !== "string" ||
          typeof decimals !== "number" ||
          !/^\d+$/.test(amount)
        ) {
          throw new Error("RPC returned malformed token account data");
        }
        return {
          address: pubkey.toBase58(),
          mint: info.mint,
          owner: info.owner,
          amountRaw: amount,
          decimals,
        };
      });
    });
  }

  async getSignaturesForAddress(
    address: PublicKey,
    options: SignaturesForAddressOptions
  ): Promise<ConfirmedSignatureInfo[]> {
    return this.request("getSignaturesForAddress", (connection) =>
      connection.getSignaturesForAddress(address, options, FINALITY)
    );
  }

  async getParsedTransaction(signature: string): Promise<ParsedTransactionWithMeta> {
    return this.request("getParsedTransaction", async (connection) => {
      const transaction = await connection.getParsedTransaction(signature, {
        commitment: FINALITY,
        maxSupportedTransactionVersion: 0,
      });
      if (!transaction) {
        throw new Error("RPC returned a null transaction");
      }
      return transaction;
    });
  }
}
