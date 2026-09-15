import { Worker } from "node:worker_threads";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// Run the parser in a worker so a synchronous loop cannot block the test runner.
const workerSource = `
const { parentPort, workerData } = require("node:worker_threads");
globalThis.window = globalThis;
globalThis.activeWindow = globalThis;
(async () => {
    const { Archiver, Extractor } = await import(workerData.archiveUrl);
    let bytes;
    if (workerData.malformed) {
        bytes = new Uint8Array(32);
        const header = new DataView(bytes.buffer);
        header.setUint32(0, 0x04034b50, true);
        header.setUint16(4, 45, true);
        header.setUint32(18, 0xffffffff, true);
        header.setUint16(26, 1, true);
        bytes[30] = 97;
    } else {
        const archiver = new Archiver();
        archiver.addTextFile("hello", "a");
        bytes = await archiver.finalize();
    }
    const extracted = {};
    const extractor = new Extractor(() => true, async (name, content) => {
        extracted[name] = new TextDecoder().decode(content);
    });
    parentPort.postMessage({ type: "ready" });
    try {
        extractor.addZippedContent(bytes, true);
        await extractor.finalise();
        parentPort.postMessage({ type: "result", extracted });
    } catch (error) {
        parentPort.postMessage({ type: "rejected", message: error.message });
    }
})().catch(error => { throw error; });
`;

async function extractInWorker(malformed: boolean): Promise<Record<string, string>> {
    const worker = new Worker(workerSource, {
        eval: true,
        workerData: {
            archiveUrl: pathToFileURL(resolve("src/Archive.ts")).href,
            malformed,
        },
        resourceLimits: { maxOldGenerationSizeMb: 128 },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error("Extractor worker did not start")), 5000);
            worker.on("error", reject);
            worker.on("exit", (code) => reject(new Error(`Extractor worker exited before reporting: ${code}`)));
            worker.on("message", (message) => {
                if (message.type === "ready") {
                    clearTimeout(timer);
                    timer = setTimeout(() => reject(new Error("Extractor did not finish parsing")), 1500);
                } else if (message.type === "rejected") {
                    reject(new Error(message.message));
                } else if (message.type === "result") {
                    resolve(message.extracted);
                }
            });
        });
    } finally {
        clearTimeout(timer);
        await worker.terminate();
    }
}

describe("Extractor ZIP64 validation", () => {
    it("extracts a valid archive in the isolated parser", async () => {
        await expect(extractInWorker(false)).resolves.toEqual({ a: "hello" });
    });

    it("rejects a ZIP64 entry without its required extra field", async () => {
        await expect(extractInWorker(true)).rejects.toThrow(/invalid zip data/i);
    });
});
