import path from "node:path";
import { BalanceService } from "./balance";
import { config } from "./config";
import { WalletMonitor } from "./monitor";
import { RpcPool } from "./rpc";
import { StateStore } from "./state";
import { TelegramService } from "./telegram";

async function main(): Promise<void> {
  const projectRoot = path.resolve(__dirname, "..");
  if (path.resolve(process.cwd()) !== projectRoot) {
    throw new Error(`Run the application from its project root: ${projectRoot}`);
  }

  console.log("[STARTUP] Configuration loaded");
  const rpc = new RpcPool(
    config.rpc.http,
    config.rpc.timeoutMs,
    config.rpc.providerCooldownMs
  );
  await rpc.getSlot();

  const balanceService = new BalanceService(rpc, config.wallet.publicKey);
  const telegram = new TelegramService(
    config.telegram.token,
    config.telegram.chatId,
    config.wallet.label,
    balanceService
  );
  const state = new StateStore(
    path.join(projectRoot, "data", "state.json"),
    config.monitor.maxRecentSignatures,
    config.monitor.maxRecentMovementIds
  );
  const monitor = new WalletMonitor(rpc, telegram, state);

  let shuttingDown = false;
  const shutdown = async (signal: string, exitCode: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[SHUTDOWN] ${signal} received`);
    await monitor.stop();
    telegram.stop(signal);
    process.exit(exitCode);
  };

  process.once("SIGINT", () => void shutdown("SIGINT", 0));
  process.once("SIGTERM", () => void shutdown("SIGTERM", 0));

  try {
    await monitor.start();
    await telegram.start();
    console.log(`[STARTUP] Monitoring active for ${config.wallet.label}`);
  } catch (error) {
    await monitor.stop();
    telegram.stop("startup failure");
    throw error;
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown startup error";
  console.error(`[FATAL] ${message}`);
  process.exitCode = 1;
});
