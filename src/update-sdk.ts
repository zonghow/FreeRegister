import {createHash} from "node:crypto";
import net from "node:net";
import {copyFile, mkdir, readFile, rename, writeFile} from "node:fs/promises";
import path from "node:path";
import tls from "node:tls";
import {Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher} from "undici";
import {SocksClient} from "socks";
import {loadConfig, readArgValue, redactProxy} from "./config.js";
import {validateSentinelSdkSource} from "./sentinel-sdk.js";

function hasFlag(argv: string[], flag: string): boolean {
    return argv.includes(flag);
}

function isSocksProtocol(protocol: string): boolean {
    return ["socks4:", "socks4a:", "socks5:", "socks5h:"].includes(protocol);
}

async function createSocksSocket(proxyUrl: URL, options: Record<string, unknown>): Promise<net.Socket> {
    const destinationHost = String(options.hostname ?? "");
    const rawPort = options.port;
    const destinationPort =
        rawPort === "" || rawPort == null
            ? (options.protocol === "https:" ? 443 : 80)
            : Number(rawPort);
    const proxyPort = Number(proxyUrl.port || 1080);
    const proxyType = proxyUrl.protocol.startsWith("socks4") ? 4 : 5;

    const connection = await SocksClient.createConnection({
        proxy: {
            host: proxyUrl.hostname,
            port: proxyPort,
            type: proxyType,
            userId: proxyUrl.username ? decodeURIComponent(proxyUrl.username) : undefined,
            password: proxyUrl.password ? decodeURIComponent(proxyUrl.password) : undefined,
        },
        command: "connect",
        destination: {
            host: destinationHost,
            port: destinationPort,
        },
    });

    const socket = connection.socket;
    if (options.protocol !== "https:") {
        return socket;
    }

    return await new Promise<net.Socket>((resolve, reject) => {
        const tlsSocket = tls.connect({
            socket,
            host: String(options.servername ?? destinationHost),
            servername: String(options.servername ?? destinationHost),
            rejectUnauthorized: false,
        });
        tlsSocket.once("secureConnect", () => resolve(tlsSocket));
        tlsSocket.once("error", reject);
    });
}

function createDispatcher(proxyUrl: string): Dispatcher {
    if (!proxyUrl) {
        return new Agent({connect: {rejectUnauthorized: false}});
    }

    const parsedProxyUrl = new URL(proxyUrl);
    if (parsedProxyUrl.protocol === "http:" || parsedProxyUrl.protocol === "https:") {
        return new ProxyAgent({
            uri: proxyUrl,
            requestTls: {
                rejectUnauthorized: false,
            },
        });
    }

    if (isSocksProtocol(parsedProxyUrl.protocol)) {
        const connect = ((options, callback) => {
            void createSocksSocket(parsedProxyUrl, options as unknown as Record<string, unknown>)
                .then((socket) => callback(null, socket))
                .catch((error) => callback(error instanceof Error ? error : new Error(String(error)), null));
        }) as NonNullable<ConstructorParameters<typeof Agent>[0]>["connect"];

        return new Agent({connect});
    }

    throw new Error(`不支持的代理协议: ${parsedProxyUrl.protocol}`);
}

async function downloadSdk(url: string, proxyUrl: string): Promise<string> {
    const dispatcher = createDispatcher(proxyUrl);
    const response = await undiciFetch(url, {
        dispatcher,
        headers: {
            accept: "application/javascript,text/javascript,*/*;q=0.8",
            "user-agent": "Mozilla/5.0 FreeRegister SDK Updater",
        },
    });
    if (!response.ok) {
        throw new Error(`下载 sdk.js 失败: status=${response.status} body=${(await response.text()).slice(0, 300)}`);
    }
    return await response.text();
}

async function writeSdkFile(filePath: string, source: string, backup: boolean): Promise<void> {
    const absolutePath = path.resolve(process.cwd(), filePath);
    await mkdir(path.dirname(absolutePath), {recursive: true});
    if (backup) {
        await copyFile(absolutePath, `${absolutePath}.bak`).catch((error) => {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
            }
        });
    }
    const tmpPath = `${absolutePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmpPath, source, "utf8");
    await rename(tmpPath, absolutePath);
}

async function readExistingSdk(filePath: string): Promise<string> {
    try {
        return await readFile(path.resolve(process.cwd(), filePath), "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return "";
        }
        throw error;
    }
}

function sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    const config = loadConfig();
    const url = readArgValue(argv, "--url").trim() || config.sentinelSdk.url;
    const file = readArgValue(argv, "--file").trim() || config.sentinelSdk.file;
    const proxy = readArgValue(argv, "--proxy").trim() || config.proxies[0] || "";
    const dryRun = hasFlag(argv, "--dry-run");
    const backup = !hasFlag(argv, "--no-backup");

    console.log(`[update:sdk] url=${url}`);
    console.log(`[update:sdk] file=${path.resolve(process.cwd(), file)}`);
    console.log(`[update:sdk] proxy=${redactProxy(proxy)}`);

    const source = await downloadSdk(url, proxy);
    validateSentinelSdkSource(source);

    const digest = sha256(source);
    const existing = await readExistingSdk(file);
    if (existing === source) {
        console.log(`[update:sdk] unchanged bytes=${Buffer.byteLength(source)} sha256=${digest}`);
        return;
    }

    if (dryRun) {
        console.log(`[update:sdk] dry-run ok bytes=${Buffer.byteLength(source)} sha256=${digest}`);
        return;
    }

    await writeSdkFile(file, source, backup);
    console.log(`[update:sdk] updated bytes=${Buffer.byteLength(source)} sha256=${digest}${backup ? " backup=.bak" : ""}`);
}

main().catch((error) => {
    console.error(`[update:sdk] failed: ${error instanceof Error ? error.stack || error.message : String(error)}`);
    process.exitCode = 1;
});
