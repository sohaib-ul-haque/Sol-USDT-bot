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

  const telegram = new TelegramService(
    config.telegram.token,
    config.telegram.chatIds,
    config.wallets.map((wallet) => ({
      label: wallet.label,
      balanceService: new BalanceService(rpc, wallet.publicKey),
    }))
  );
  const monitors = config.wallets.map((wallet, index) => {
    // The first wallet keeps the original state file so existing checkpoints carry over.
    const fileName = index === 0 ? "state.json" : `state-${wallet.address}.json`;
    const state = new StateStore(
      path.join(projectRoot, "data", fileName),
      config.monitor.maxRecentSignatures,
      config.monitor.maxRecentMovementIds
    );
    return new WalletMonitor(rpc, telegram, state, wallet, index === 0);
  });

  let shuttingDown = false;
  const stopMonitors = async (): Promise<void> => {
    await Promise.all(monitors.map((monitor) => monitor.stop()));
  };
  const shutdown = async (signal: string, exitCode: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[SHUTDOWN] ${signal} received`);
    await stopMonitors();
    telegram.stop(signal);
    process.exit(exitCode);
  };

  process.once("SIGINT", () => void shutdown("SIGINT", 0));
  process.once("SIGTERM", () => void shutdown("SIGTERM", 0));

  try {
    for (const monitor of monitors) await monitor.start();
    await telegram.start();
    console.log(
      `[STARTUP] Monitoring active for ${config.wallets.map((wallet) => wallet.label).join(", ")}`
    );
  } catch (error) {
    await stopMonitors();
    telegram.stop("startup failure");
    throw error;
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown startup error";
  console.error(`[FATAL] ${message}`);
  process.exitCode = 1;
});
