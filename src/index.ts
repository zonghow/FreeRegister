import {applyCliOverrides, loadConfig} from "./config.js";
import {RegisterTaskRunner} from "./runner.js";

async function main(): Promise<void> {
    const config = applyCliOverrides(loadConfig());
    const runner = new RegisterTaskRunner();

    let stopping = false;
    const shutdown = (signal: NodeJS.Signals, exitCode: number): void => {
        if (stopping) {
            process.exit(exitCode);
        }
        stopping = true;
        console.warn(`[FreeRegister] 收到 ${signal}，强制暂停任务并退出`);
        runner.forcePause();
        const forceExitTimer = setTimeout(() => {
            console.error(`[FreeRegister] ${signal} 后等待任务退出超时，强制退出`);
            process.exit(exitCode);
        }, 9000);
        forceExitTimer.unref?.();
        void runner.wait().finally(() => {
            clearTimeout(forceExitTimer);
            process.exit(exitCode);
        });
    };

    process.once("SIGINT", () => shutdown("SIGINT", 130));
    process.once("SIGTERM", () => shutdown("SIGTERM", 143));

    runner.start(config);
    const result = await runner.wait();
    if (result.failedCount > 0 || result.status === "failed") {
        process.exitCode = 1;
    }
}

main().catch((error) => {
    console.error(`[FreeRegister] 致命错误: ${error instanceof Error ? error.stack || error.message : String(error)}`);
    process.exitCode = 1;
});
