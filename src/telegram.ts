import { Context, Telegraf } from "telegraf";
import { BalanceService } from "./balance";
import { TokenMovement } from "./parser";

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatDecimal(value: string): string {
  const [whole = "0", fraction] = value.split(".");
  const grouped = BigInt(whole).toLocaleString("en-US");
  return fraction ? `${grouped}.${fraction}` : grouped;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TelegramService {
  private readonly bot: Telegraf;
  private started = false;

  constructor(
    token: string,
    private readonly chatIds: string[],
    private readonly walletLabel: string,
    private readonly balanceService: BalanceService
  ) {
    this.bot = new Telegraf(token);
    this.registerCommands();
    this.bot.catch(() => {
      console.error("[TELEGRAM] Update handler failed");
    });
  }

  async start(): Promise<void> {
    await this.bot.launch();
    this.started = true;
    console.log("[TELEGRAM] Bot polling started");
  }

  stop(reason: string): void {
    if (!this.started) return;
    this.bot.stop(reason);
    this.started = false;
  }

  async sendMovement(movement: TokenMovement): Promise<void> {
    const directionLabel = movement.direction === "INFLOW" ? "Inflow" : "Outflow";
    const text =
      `<b>${movement.symbol} ${directionLabel}</b>\n\n` +
      `<b>Wallet:</b> ${escapeHtml(this.walletLabel)}\n` +
      `<b>Amount:</b> ${formatDecimal(movement.amount)} ${movement.symbol}\n` +
      `<b>Tx From:</b> <code>${escapeHtml(movement.txFrom)}</code>\n` +
      `<b>From:</b> <code>${escapeHtml(movement.fromOwner)}</code>\n` +
      `<b>To:</b> <code>${escapeHtml(movement.toOwner)}</code>\n` +
      `<b>Tx:</b> <code>${movement.signature}</code>\n` +
      `<b>Block:</b> ${movement.slot}\n` +
      `<a href="https://solscan.io/tx/${movement.signature}">Open on Solscan</a>`;

    const results = await Promise.all(
      this.chatIds.map((chatId) => this.deliver(chatId, text))
    );
    const delivered = results.filter(Boolean).length;
    if (delivered === 0) {
      throw new Error("Telegram did not acknowledge the alert after retries");
    }
    console.log(
      `[ALERT] ${movement.symbol} ${movement.direction.toLowerCase()} sent to ${delivered}/${this.chatIds.length} chat(s)`
    );
  }

  private async deliver(chatId: string, text: string): Promise<boolean> {
    const delays = [0, 2_000, 5_000];
    for (let attempt = 0; attempt < delays.length; attempt += 1) {
      const delay = delays[attempt] ?? 0;
      if (delay > 0) await sleep(delay);
      try {
        await this.bot.telegram.sendMessage(chatId, text, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        });
        return true;
      } catch {
        console.warn(`[TELEGRAM] Delivery to chat ${chatId} attempt ${attempt + 1} failed`);
      }
    }
    return false;
  }

  private registerCommands(): void {
    this.bot.start(async (context) => {
      if (!this.isAuthorized(context)) return;
      await context.reply(
        `${this.walletLabel} read-only Solana USDC/USDT wallet monitor.\nUse /balance for current SOL, USDC, and USDT balances.`
      );
    });

    this.bot.command("balance", async (context) => {
      if (!this.isAuthorized(context)) return;
      try {
        const balances = await this.balanceService.getCurrentBalances();
        await context.reply(
          `💰 ${this.walletLabel} Balance\n\n` +
            `SOL: ${formatDecimal(balances.sol)}\n` +
            `USDC: ${formatDecimal(balances.usdc)}\n` +
            `USDT: ${formatDecimal(balances.usdt)}`
        );
      } catch {
        console.warn("[TELEGRAM] /balance RPC request failed");
        await context.reply("Balance lookup is temporarily unavailable. Please try again shortly.");
      }
    });
  }

  private isAuthorized(context: Context): boolean {
    return this.chatIds.includes(String(context.chat?.id ?? ""));
  }
}
