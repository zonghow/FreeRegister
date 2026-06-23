import assert from "node:assert/strict";
import {createServer} from "node:http";
import type {AddressInfo} from "node:net";
import test from "node:test";
import {OpenAIClient} from "../src/openai.js";

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
    });
}

test("OpenAI fetch times out as a normal request failure without retries", async () => {
    let requests = 0;
    const server = createServer((_req, res) => {
        requests += 1;
        setTimeout(() => {
            if (!res.destroyed) {
                res.end("too late");
            }
        }, 200);
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const client = new OpenAIClient({
        password: "unused",
        proxyUrl: "",
        fetchTimeoutMs: 30,
    });

    try {
        await assert.rejects(
            client.fetch(`http://127.0.0.1:${address.port}/slow`),
            /OpenAI fetch 请求超时: .*timeout=30ms/,
        );
        assert.equal(requests, 1);
    } finally {
        await client.close();
        await closeServer(server);
    }
});
