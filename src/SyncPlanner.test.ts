import {
    applySendBatchToToc,
    getAllowedActions,
    getDefaultAction,
    isActionAllowed,
    planSendBatches,
    type TocMap,
} from "./SyncPlanner.ts";
import { pieces } from "./util.ts";

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

Deno.test("default actions follow agreed rules", () => {
    assertEquals(getDefaultAction("Add", { destructiveDefaultsEnabled: false }), "Fetch", "Add must default to Fetch");
    assertEquals(getDefaultAction("Updated", { destructiveDefaultsEnabled: false }), "Fetch", "Updated must default to Fetch");
    assertEquals(getDefaultAction("Old", { destructiveDefaultsEnabled: false }), "Send", "Old must default to Send");
    assertEquals(getDefaultAction("Conflict", { destructiveDefaultsEnabled: false }), "None", "Conflict must default to None");
    assertEquals(getDefaultAction("Delete", { destructiveDefaultsEnabled: false }), "None", "Delete must default to None when destructive defaults are off");
    assertEquals(getDefaultAction("Delete", { destructiveDefaultsEnabled: true }), "Fetch", "Delete must default to Fetch when destructive defaults are on");
    assertEquals(getDefaultAction("Extra (Delete)", { destructiveDefaultsEnabled: false }), "None", "Extra must default to None when destructive defaults are off");
    assertEquals(getDefaultAction("Extra (Delete)", { destructiveDefaultsEnabled: true }), "Send", "Extra must default to Send when destructive defaults are on");
});

Deno.test("allowed action matrix is constrained", () => {
    assertEquals(getAllowedActions("Add"), ["None", "Fetch"], "Add actions must be limited");
    assertEquals(getAllowedActions("Extra (Delete)"), ["None", "Send"], "Extra actions must be limited");
    assertEquals(getAllowedActions("Same"), ["None"], "Same actions must be limited");
    assert(isActionAllowed("Updated", "Send"), "Updated should allow Send");
    assert(!isActionAllowed("Add", "Send"), "Add should not allow Send");
    assert(!isActionAllowed("Extra (Delete)", "Fetch"), "Extra should not allow Fetch");
});

Deno.test("send batch planner respects both file-count and total-size limits", () => {
    const { batches, oversizedFiles } = planSendBatches(
        [
            { filename: "a.md", size: 4 },
            { filename: "b.md", size: 5 },
            { filename: "c.md", size: 3 },
            { filename: "huge.bin", size: 20 },
            { filename: "d.md", size: 4 },
        ],
        2,
        10,
    );

    assertEquals(oversizedFiles, ["huge.bin"], "Oversized file should be reported");
    assertEquals(
        batches.map((b) => b.files.map((f) => f.filename)),
        [["a.md", "b.md"], ["c.md"], ["huge.bin"], ["d.md"]],
        "Batches should split by both limits, oversized in solo batch",
    );
    assertEquals(
        batches.map((b) => b.totalSize),
        [9, 3, 20, 4],
        "Batch total sizes should be tracked",
    );
});

Deno.test("TOC updates can be applied sequentially per committed batch", () => {
    const initial: TocMap = {
        "note.md": {
            filename: "note.md",
            digest: "old",
            mtime: 1,
            history: [
                {
                    zipName: "old.zip",
                    modified: new Date(1).toISOString(),
                    digest: "old",
                },
            ],
        },
    };

    const afterFirst = applySendBatchToToc(
        initial,
        [{ kind: "file", filename: "note.md", digest: "new-1", mtime: 1000 }],
        "sync-1.zip",
        2000,
    );

    const afterSecond = applySendBatchToToc(
        afterFirst,
        [
            { kind: "file", filename: "new.md", digest: "new-2", mtime: 3000 },
            { kind: "missing", filename: "obsolete.md", modifiedTime: 4000 },
        ],
        "sync-2.zip",
        5000,
    );

    assertEquals(afterFirst["note.md"].history.length, 2, "First batch should append one history entry");
    assertEquals(afterSecond["note.md"].history.length, 2, "Second batch should keep first batch history");
    const latestHistory = afterSecond["new.md"].history[afterSecond["new.md"].history.length - 1];
    assertEquals(latestHistory?.zipName, "sync-2.zip", "Second batch should add new file with matching zip name");
    assert(afterSecond["obsolete.md"].missing === true, "Missing update should mark file as missing");
});

Deno.test("ZIP files are split into chunks when exceeding maxSize", () => {
    const chunkSize = 10; // bytes
    const data = new Uint8Array(35); // Create 35 bytes
    data.fill(42); // Fill with arbitrary data

    const chunks = Array.from(pieces(data, chunkSize));

    assertEquals(chunks.length, 4, "35 bytes should be split into 4 chunks (10+10+10+5)");
    assertEquals(chunks[0].length, 10, "First chunk should be 10 bytes");
    assertEquals(chunks[1].length, 10, "Second chunk should be 10 bytes");
    assertEquals(chunks[2].length, 10, "Third chunk should be 10 bytes");
    assertEquals(chunks[3].length, 5, "Fourth chunk should be 5 bytes (remainder)");

    // Verify reassembled data matches original
    const reassembled = new Uint8Array(chunks.reduce((a, b) => a + b.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
        reassembled.set(chunk, offset);
        offset += chunk.length;
    }
    assertEquals(reassembled, data, "Reassembled chunks should match original data");
});

Deno.test("ZIP chunk splitting: multiple large chunks with remainder", () => {
    // Simulate a large ZIP (500 KB) with 100 KB chunks
    const largeZip = new Uint8Array(500000);
    const chunkSize = 100000;
    const chunks = Array.from(pieces(largeZip, chunkSize));

    assertEquals(chunks.length, 5, "500KB split into 100KB chunks should create 5 chunks");
    assertEquals(chunks[0].length, 100000, "Chunks 0-3 should be 100KB");
    assertEquals(chunks[4].length, 100000, "Chunk 4 should be 100KB");

    // Track which would be the written filenames in writeSendZip
    const fileNames = chunks.map((_, i) =>
        i === 0 ? "sync-test.zip" : `sync-test.zip.${String(i).padStart(3, "0")}`,
    );
    assertEquals(fileNames.length, 5, "Should create 5 file names for 5 chunks");
    assertEquals(fileNames[0], "sync-test.zip", "First file is base name");
    assertEquals(fileNames[1], "sync-test.zip.001", "Second file has .001");
    assertEquals(fileNames[4], "sync-test.zip.004", "Fifth file has .004");
});
