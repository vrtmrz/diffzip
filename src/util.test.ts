import { ellipsisMiddle, humanReadableSize, toArrayBuffer } from "./util.ts";

declare const Deno: {
    test: (name: string, fn: () => void | Promise<void>) => void;
};

function assert(condition: unknown, message: string) {
    if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message: string) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${message}\nactual=${JSON.stringify(actual)}\nexpected=${JSON.stringify(expected)}`);
    }
}

Deno.test("toArrayBuffer: returns backing ArrayBuffer for supported binary views", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    assert(toArrayBuffer(bytes) === bytes.buffer, "Uint8Array should return its backing buffer");

    const view = new DataView(bytes.buffer);
    assert(toArrayBuffer(view) === bytes.buffer, "DataView should return its backing buffer");

    assert(toArrayBuffer(bytes.buffer) === bytes.buffer, "ArrayBuffer should be returned as-is");
});

Deno.test("humanReadableSize: formats edge cases and byte units", () => {
    assertEquals(humanReadableSize(Number.NaN), "0 B", "NaN should format as 0 B");
    assertEquals(humanReadableSize(-1), "0 B", "negative values should format as 0 B");
    assertEquals(humanReadableSize(512), "512 B", "bytes should not be scaled");
    assertEquals(humanReadableSize(1024), "1 KB", "1024 bytes should format as 1 KB");
    assertEquals(humanReadableSize(1536), "1.5 KB", "fractional KB should keep useful precision");
    assertEquals(humanReadableSize(10 * 1024), "10 KB", "whole two-digit units should trim trailing decimals");
    assertEquals(humanReadableSize(1024 ** 5 * 2), "2 PB", "large values should cap at PB");
});

Deno.test("ellipsisMiddle: keeps short text and truncates long text in the middle", () => {
    assertEquals(ellipsisMiddle("short", 10), "short", "short text should be unchanged");
    assertEquals(ellipsisMiddle("abcdefghijklmnopqrstuvwxyz", 10), "abcd...xyz", "long text should be shortened in the middle");
});
