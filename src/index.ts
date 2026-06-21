import {applyCliOverrides, loadConfig} from "./config.js";
import {RegisterTaskRunner} from "./runner.js";

async function main(): Promise<void> {
    const config = applyCliOverrides(loadConfig());
    const runner = new RegisterTaskRunner();

    let stopping = false;
    process.once("SIGINT", () => {
        if (stopping) {
            process.exit(130);
        }
        stopping = true;
        runner.pause();
    });

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
