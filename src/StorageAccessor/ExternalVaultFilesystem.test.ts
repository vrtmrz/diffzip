// eslint-disable-next-line import/no-nodejs-modules -- Electron file reads return Node Buffers.
import { Buffer } from "node:buffer";
import { ExternalVaultFilesystem } from "./ExternalVaultFilesystem.ts";
import type { StorageAccessorHost } from "./storage-accessor-types.ts";

declare const Deno: {
    test: (name: string, fn: () => void | Promise<void>) => void;
};

function assertEquals<T>(actual: T, expected: T, message: string) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${message}\nactual=${JSON.stringify(actual)}\nexpected=${JSON.stringify(expected)}`);
    }
}

Deno.test("ExternalVaultFilesystem: reads only the visible Node Buffer bytes", async () => {
    const backing = Buffer.from([99, 1, 2, 3, 88]);
    const visible = backing.subarray(1, 4);
    const plugin = {
        app: {
            vault: {
                adapter: {
                    fsPromises: {
                        readFile: async () => visible,
                    },
                },
            },
        },
    } as unknown as StorageAccessorHost;
    const storage = new ExternalVaultFilesystem(plugin);

    const result = await storage._readBinary("archive.bin");
    if (result === false) throw new Error("Expected binary data");

    assertEquals([...new Uint8Array(result)], [1, 2, 3], "Buffer byte offset and length should be preserved");
});
