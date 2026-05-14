// Polyfill: Obsidian provides `window`, but Deno does not.
// Archive.ts uses `window.setTimeout`, so we patch it here before importing.
if (typeof window === "undefined") {
    (globalThis as unknown as Record<string, unknown>).window = globalThis;
    (globalThis as unknown as Record<string, unknown>).activeWindow = globalThis;
}

import { Archiver, Extractor } from "./Archive.ts";

declare const Deno: {
    test: (name: string, fn: () => void | Promise<void>) => void;
};

function assert(condition: unknown, message: string) {
    if (!condition) {
        throw new Error(message);
    }
}

function assertEquals<T>(actual: T, expected: T, message: string) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${message}\nactual=${JSON.stringify(actual)}\nexpected=${JSON.stringify(expected)}`);
    }
}

Deno.test("Archiver + Extractor: round-trip a single text file", async () => {
    const archiver = new Archiver();
    archiver.addTextFile("hello, world", "note.md");
    const zipData = await archiver.finalize();

    const extracted: Record<string, string> = {};
    const extractor = new Extractor(
        () => true,
        async (filename, content) => {
            extracted[filename] = new TextDecoder().decode(content);
        },
    );
    extractor.addZippedContent(zipData, true);
    // Give async callbacks time to settle
    await new Promise((res) => setTimeout(res, 100));

    assertEquals(extracted["note.md"], "hello, world", "Extracted content must match original");
});

Deno.test("Archiver + Extractor: round-trip multiple files", async () => {
    const files: Record<string, string> = {
        "a.md": "alpha",
        "b.md": "beta",
        "c.md": "gamma",
    };

    const archiver = new Archiver();
    for (const [path, text] of Object.entries(files)) {
        archiver.addTextFile(text, path);
    }
    const zipData = await archiver.finalize();

    const extracted: Record<string, string> = {};
    const extractor = new Extractor(
        () => true,
        async (filename, content) => {
            extracted[filename] = new TextDecoder().decode(content);
        },
    );
    extractor.addZippedContent(zipData, true);
    await new Promise((res) => setTimeout(res, 100));

    for (const [path, text] of Object.entries(files)) {
        assertEquals(extracted[path], text, `Extracted content of ${path} must match original`);
    }
});

Deno.test("Extractor: filter function skips unwanted files", async () => {
    const archiver = new Archiver();
    archiver.addTextFile("keep me", "keep.md");
    archiver.addTextFile("skip me", "skip.md");
    const zipData = await archiver.finalize();

    const extracted: Record<string, string> = {};
    const extractor = new Extractor(
        (file) => file.name === "keep.md",
        async (filename, content) => {
            extracted[filename] = new TextDecoder().decode(content);
        },
    );
    extractor.addZippedContent(zipData, true);
    await new Promise((res) => setTimeout(res, 100));

    assert("keep.md" in extracted, "keep.md must be extracted");
    assert(!("skip.md" in extracted), "skip.md must be skipped");
});

Deno.test("Archiver: currentSize grows as files are added", async () => {
    const archiver = new Archiver();
    const before = archiver.currentSize;
    archiver.addTextFile("some content", "file.md");
    // finalize to flush all data into _output
    await archiver.finalize();
    const after = archiver.currentSize;

    assert(after > before, "currentSize must increase after adding a file");
});

// chunkSize > MIN_CHUNK_SIZE (64KB) when file.length > 640KB.
// Use 800KB to ensure multi-chunk path and progress callback are exercised.
Deno.test("Archiver: large file triggers multi-chunk path and progress callback", async () => {
    const SIZE = 800 * 1024; // 800KB
    const original = new Uint8Array(SIZE);
    // Fill with a recognisable pattern so round-trip can be verified
    for (let i = 0; i < SIZE; i++) original[i] = i & 0xff;

    const progressCalls: Array<{ processed: number; total: number; finished: boolean }> = [];
    const archiver = new Archiver();
    archiver.addFile(original, "large.bin", {}, (processed, total, finished) => {
        progressCalls.push({ processed, total, finished });
    });
    const zipData = await archiver.finalize();

    // Progress callback must have been called at least once during chunking
    assert(progressCalls.length > 0, "progress callback must be called for large files");
    // The final call must mark finished=true
    assert(progressCalls.at(-1)!.finished, "last progress call must have finished=true");
    // Processed bytes must equal total at the end
    assertEquals(progressCalls.at(-1)!.processed, SIZE, "processed must equal total size on finish");

    // Round-trip verification
    const extracted: Record<string, Uint8Array> = {};
    const extractor = new Extractor(
        () => true,
        async (filename, content) => {
            extracted[filename] = content;
        },
    );
    extractor.addZippedContent(zipData, true);
    await new Promise((res) => setTimeout(res, 500));

    assert("large.bin" in extracted, "large.bin must be extracted");
    assertEquals(extracted["large.bin"].length, SIZE, "Extracted size must match original");
    assertEquals(extracted["large.bin"][0], original[0], "First byte must match");
    assertEquals(extracted["large.bin"][SIZE - 1], original[SIZE - 1], "Last byte must match");
});

Deno.test("Extractor: finalise() correctly ends streamed zip input", async () => {
    // Build a zip first
    const archiver = new Archiver();
    archiver.addTextFile("streamed content", "stream.md");
    const zipData = await archiver.finalize();

    const extracted: Record<string, string> = {};
    const extractor = new Extractor(
        () => true,
        async (filename, content) => {
            extracted[filename] = new TextDecoder().decode(content);
        },
    );

    // Feed zip data in two chunks WITHOUT isFinal, then call finalise() separately
    const half = Math.floor(zipData.length / 2);
    extractor.addZippedContent(zipData.slice(0, half), false);
    extractor.addZippedContent(zipData.slice(half), false);
    extractor.finalise();

    await new Promise((res) => setTimeout(res, 200));

    assertEquals(extracted["stream.md"], "streamed content", "Streamed extraction via finalise() must match original");
});
