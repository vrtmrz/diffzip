/**
 * Tests for detectChangedFiles, planBatches, and packBatches generators.
 *
 * packBatches uses Archiver which relies on window.setTimeout — polyfill first.
 */
if (typeof window === "undefined") {
    (globalThis as unknown as Record<string, unknown>).window = globalThis;
    (globalThis as unknown as Record<string, unknown>).activeWindow = globalThis;
}

import { detectChangedFiles, packBatches, planBatches, type PrepFile, type ProgressReporter, type VaultReader } from "./tasks.ts";
import type { TocUpdate } from "./SyncPlanner.ts";
import type { FileInfo, FileInfos } from "./types.ts";
import { DEFAULT_SETTINGS } from "./types.ts";
import { computeDigest } from "./util.ts";


declare const Deno: {
    test: (name: string, fn: () => void | Promise<void>) => void;
};

// ── assertion helpers ──────────────────────────────────────────────────────────

function assert(condition: unknown, message: string) {
    if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message: string) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${message}\nactual  = ${JSON.stringify(actual)}\nexpected= ${JSON.stringify(expected)}`);
    }
}

// ── generator helpers ─────────────────────────────────────────────────────────

async function* fromItems<T>(items: T[]): AsyncGenerator<T, void, void> {
    for (const item of items) yield item;
}

async function collect<T>(gen: AsyncGenerator<T, void, void>): Promise<T[]> {
    const out: T[] = [];
    for await (const item of gen) out.push(item);
    return out;
}

// ── stub factories ─────────────────────────────────────────────────────────────

/** Minimal ProgressFragment-compatible stub (uses only setters). */
function mockProgress(): ProgressReporter {
    return { total: 0, value: 0, note: "", isCancelled: false };
}

/** StorageAccessor stub backed by an in-memory file map. */
function makeVault(
    files: Record<string, { content: ArrayBuffer; mtime: number }>,
): VaultReader {
    return {
        normalizePath: (p: string) => p,
        isFileExists: async (p: string) => p in files,
        stat: async (p: string) => (p in files ? { mtime: files[p].mtime } : false),
        readBinary: async (p: string) => (p in files ? files[p].content : false),
    };
}

function textBuffer(s: string): ArrayBuffer {
    return new TextEncoder().encode(s).buffer as ArrayBuffer;
}

/** Bare-minimum FileInfo entry. */
function tocEntry(digest: string, mtime = 1000): FileInfo {
    return { filename: "", digest, mtime, history: [] };
}

function makeFile(filename: string, size: number): PrepFile {
    return {
        filename,
        content: new Uint8Array(size) as unknown as Uint8Array<ArrayBuffer>,
        digest: `d-${filename}`,
        mtime: 1577836800000, // 2020-01-01 UTC
        size,
    };
}

function missing(filename: string): TocUpdate {
    return { kind: "missing", filename, modifiedTime: 2000 };
}

// ─────────────────────────────────────────────────────────────────────────────
// planBatches
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("planBatches: empty source yields nothing", async () => {
    const result = await collect(planBatches(fromItems([]), 10, 100));
    assertEquals(result.length, 0, "no batches from empty source");
});

Deno.test("planBatches: only TocUpdates → one batch with empty files", async () => {
    const items = [missing("gone.md"), missing("also-gone.md")];
    const [batch] = await collect(planBatches(fromItems(items), 10, 0));
    assert(batch !== undefined, "should yield one batch");
    assertEquals(batch.files.length, 0, "batch files must be empty");
    assertEquals(
        batch.missingUpdates.map((u) => u.filename),
        ["gone.md", "also-gone.md"],
        "all missing updates in the single batch",
    );
});

Deno.test("planBatches: files within limits → one batch, no missingUpdates", async () => {
    const items = [makeFile("a.md", 5), makeFile("b.md", 3)];
    const result = await collect(planBatches(fromItems(items), 10, 100));
    assertEquals(result.length, 1, "single batch");
    assertEquals(
        result[0].files.map((f) => f.filename),
        ["a.md", "b.md"],
        "both files in batch",
    );
    assertEquals(result[0].missingUpdates.length, 0, "no missing updates");
});

Deno.test("planBatches: exceeds file-count limit → splits, missingUpdates on first", async () => {
    // 1 missing + 4 files, maxFiles=2
    const items: (PrepFile | TocUpdate)[] = [
        missing("del.md"),
        makeFile("a.md", 1),
        makeFile("b.md", 1),
        makeFile("c.md", 1),
        makeFile("d.md", 1),
    ];
    const result = await collect(planBatches(fromItems(items), 2, 0));
    assertEquals(result.length, 2, "two batches");
    assertEquals(result[0].files.map((f) => f.filename), ["a.md", "b.md"], "first batch files");
    assertEquals(
        result[0].missingUpdates.map((u) => u.filename),
        ["del.md"],
        "missingUpdates flushed with first batch",
    );
    assertEquals(result[1].files.map((f) => f.filename), ["c.md", "d.md"], "second batch files");
    assertEquals(result[1].missingUpdates.length, 0, "second batch has no missingUpdates");
});

Deno.test("planBatches: exceeds total-size limit → splits batches", async () => {
    // a=6, b=6, c=4; maxSize=10 → [a+b=12 > 10, flush after a] → [a],[b,c=10]
    const items = [makeFile("a.md", 6), makeFile("b.md", 6), makeFile("c.md", 4)];
    const result = await collect(planBatches(fromItems(items), 0, 10));
    assertEquals(result.length, 2, "two size-based batches");
    assertEquals(result[0].files.map((f) => f.filename), ["a.md"], "first batch: a alone");
    assertEquals(result[1].files.map((f) => f.filename), ["b.md", "c.md"], "second batch: b+c fit");
});

Deno.test("planBatches: oversized file → solo batch, flushes current accumulation first", async () => {
    // a=4, huge=15 (> maxSize=10), b=3
    const items = [makeFile("a.md", 4), makeFile("huge.bin", 15), makeFile("b.md", 3)];
    const result = await collect(planBatches(fromItems(items), 0, 10));
    assertEquals(result.length, 3, "three batches");
    assertEquals(result[0].files.map((f) => f.filename), ["a.md"], "first: a");
    assertEquals(result[1].files.map((f) => f.filename), ["huge.bin"], "second: huge solo");
    assertEquals(result[2].files.map((f) => f.filename), ["b.md"], "third: b");
});

Deno.test("planBatches: missingUpdates interleaved with files go into next flush", async () => {
    // missing1 then file-a, then missing2, then file-b → both flush at the end
    const items: (PrepFile | TocUpdate)[] = [
        missing("gone1.md"),
        makeFile("a.md", 1),
        missing("gone2.md"),
        makeFile("b.md", 1),
    ];
    // no limits → single batch at the end
    const result = await collect(planBatches(fromItems(items), 0, 0));
    assertEquals(result.length, 1, "single batch");
    assertEquals(result[0].files.map((f) => f.filename), ["a.md", "b.md"], "all files");
    assertEquals(
        result[0].missingUpdates.map((u) => u.filename).sort(),
        ["gone1.md", "gone2.md"],
        "both missing updates in the batch",
    );
});

// ─────────────────────────────────────────────────────────────────────────────
// detectChangedFiles
// ─────────────────────────────────────────────────────────────────────────────

const baseSettings = { ...DEFAULT_SETTINGS, restoreFolder: "restored" };
const today = new Date(3000);

Deno.test("detectChangedFiles: new file (not in TOC) is yielded as PrepFile", async () => {
    const content = textBuffer("hello");
    const vault = makeVault({ "note.md": { content, mtime: 1000 } });
    const results = await collect(
        detectChangedFiles(
            false, false, mockProgress(), mockProgress(), () => {},
            {}, ["note.md"], vault, "backups", () => {}, () => {}, () => {}, "/", baseSettings, today,
        ),
    );
    assertEquals(results.length, 1, "one item yielded");
    const item = results[0];
    assert(!("kind" in item), "should be a PrepFile, not TocUpdate");
    const file = item as PrepFile;
    assertEquals(file.filename, "note.md", "filename");
    assertEquals(file.size, 5, "size (5 bytes = 'hello')");
});

Deno.test("detectChangedFiles: unchanged file (same digest) is not yielded", async () => {
    const content = textBuffer("unchanged content");
    const arr = new Uint8Array(content);
    const digest = await computeDigest(arr);

    const toc: FileInfos = { "note.md": { ...tocEntry(digest, 1000), filename: "note.md" } };
    const vault = makeVault({ "note.md": { content, mtime: 1000 } });

    const results = await collect(
        detectChangedFiles(
            false, false, mockProgress(), mockProgress(), () => {},
            toc, ["note.md"], vault, "backups", () => {}, () => {}, () => {}, "/", baseSettings, today,
        ),
    );
    assertEquals(results.length, 0, "unchanged file must not be yielded");
});

Deno.test("detectChangedFiles: changed file (different digest) is yielded as PrepFile", async () => {
    const content = textBuffer("new content");
    const toc: FileInfos = { "note.md": { ...tocEntry("old-digest", 1000), filename: "note.md" } };
    const vault = makeVault({ "note.md": { content, mtime: 1000 } });

    const results = await collect(
        detectChangedFiles(
            false, false, mockProgress(), mockProgress(), () => {},
            toc, ["note.md"], vault, "backups", () => {}, () => {}, () => {}, "/", baseSettings, today,
        ),
    );
    assertEquals(results.length, 1, "changed file must be yielded");
    assert(!("kind" in results[0]), "should be PrepFile");
});

Deno.test("detectChangedFiles: file in TOC but missing from vault yields TocUpdate", async () => {
    const toc: FileInfos = { "gone.md": { ...tocEntry("some-digest"), filename: "gone.md" } };
    const vault = makeVault({}); // vault is empty

    const results = await collect(
        detectChangedFiles(
            false, false, mockProgress(), mockProgress(), () => {},
            toc, [], vault, "backups", () => {}, () => {}, () => {}, "/", baseSettings, today,
        ),
    );
    assertEquals(results.length, 1, "one item for missing file");
    const item = results[0];
    assert("kind" in item, "should be TocUpdate");
    const update = item as TocUpdate;
    assert(update.kind === "missing", "kind must be 'missing'");
    assertEquals(update.filename, "gone.md", "filename");
});

Deno.test("detectChangedFiles: skipDeleted=true suppresses TocUpdate for missing file", async () => {
    const toc: FileInfos = { "gone.md": { ...tocEntry("some-digest"), filename: "gone.md" } };
    const vault = makeVault({});

    const results = await collect(
        detectChangedFiles(
            false, true /* skipDeleted */, mockProgress(), mockProgress(), () => {},
            toc, [], vault, "backups", () => {}, () => {}, () => {}, "/", baseSettings, today,
        ),
    );
    assertEquals(results.length, 0, "skipDeleted should suppress missing TocUpdate");
});

Deno.test("detectChangedFiles: onlyNew=true skips file whose mtime has not advanced", async () => {
    const content = textBuffer("content");
    // TOC has mtime=2000; vault also reports mtime=2000 → same or older → skip
    const toc: FileInfos = { "note.md": { ...tocEntry("old-digest", 2000), filename: "note.md" } };
    const vault = makeVault({ "note.md": { content, mtime: 2000 } });

    const results = await collect(
        detectChangedFiles(
            true /* onlyNew */, false, mockProgress(), mockProgress(), () => {},
            toc, ["note.md"], vault, "backups", () => {}, () => {}, () => {}, "/", baseSettings, today,
        ),
    );
    assertEquals(results.length, 0, "onlyNew: mtime not advanced should be skipped");
});

Deno.test("detectChangedFiles: files inside backupFolder are excluded", async () => {
    const content = textBuffer("backup content");
    const vault = makeVault({ "backups/backup.zip": { content, mtime: 1000 } });

    const results = await collect(
        detectChangedFiles(
            false, false, mockProgress(), mockProgress(), () => {},
            {}, ["backups/backup.zip"], vault, "backups", () => {}, () => {}, () => {}, "/", baseSettings, today,
        ),
    );
    assertEquals(results.length, 0, "files inside backupFolder must be excluded");
});

// ─────────────────────────────────────────────────────────────────────────────
// packBatches
// ─────────────────────────────────────────────────────────────────────────────

function emptyToc(): FileInfos {
    return {};
}

Deno.test("packBatches: single batch yields ArchivedBatch with correct metadata", async () => {
    const files = [makeFile("a.md", 4), makeFile("b.md", 3)];
    const planned = fromItems([{ files, missingUpdates: [] }]);

    const results = await collect(
        packBatches(planned, (i) => `backup-${i}.zip`, emptyToc(), 9000, () => {}, mockProgress(), mockProgress(), JSON.stringify),
    );

    assertEquals(results.length, 1, "one ArchivedBatch");
    assertEquals(results[0].batchIndex, 0, "batchIndex = 0");
    assertEquals(results[0].zipName, "backup-0.zip", "zipName from makeZipName");
    assertEquals(results[0].fileCount, 2, "fileCount = 2");
});

Deno.test("packBatches: batchIndex increments across multiple batches", async () => {
    const planned = fromItems([
        { files: [makeFile("a.md", 1)], missingUpdates: [] },
        { files: [makeFile("b.md", 1)], missingUpdates: [] },
        { files: [makeFile("c.md", 1)], missingUpdates: [] },
    ]);

    const results = await collect(
        packBatches(planned, (i) => `z${i}.zip`, emptyToc(), 9000, () => {}, mockProgress(), mockProgress(), JSON.stringify),
    );

    assertEquals(results.length, 3, "three batches");
    assertEquals(results.map((r) => r.batchIndex), [0, 1, 2], "batchIndex sequence");
    assertEquals(results.map((r) => r.zipName), ["z0.zip", "z1.zip", "z2.zip"], "zipNames");
});

Deno.test("packBatches: batch with only missingUpdates yields ArchivedBatch with fileCount=0", async () => {
    const planned = fromItems([{ files: [], missingUpdates: [missing("gone.md")] }]);

    const results = await collect(
        packBatches(planned, (i) => `backup-${i}.zip`, emptyToc(), 9000, () => {}, mockProgress(), mockProgress(), JSON.stringify),
    );

    assertEquals(results.length, 1, "one batch");
    assertEquals(results[0].fileCount, 0, "fileCount = 0");
    assertEquals(results[0].batchIndex, 0, "batchIndex = 0");
});

Deno.test("packBatches: nextToc reflects file and missing TocUpdates", async () => {
    const files = [makeFile("note.md", 4)];
    const planned = fromItems([{ files, missingUpdates: [missing("gone.md")] }]);

    const [batch] = await collect(
        packBatches(planned, (_i) => "b0.zip", emptyToc(), 9000, () => {}, mockProgress(), mockProgress(), JSON.stringify),
    );

    assert("note.md" in batch.nextToc, "nextToc should contain note.md");
    assert("gone.md" in batch.nextToc, "nextToc should contain gone.md");
    assertEquals(batch.nextToc["gone.md"].missing, true, "gone.md marked missing in TOC");
    assertEquals(batch.nextToc["note.md"].missing, false, "note.md not missing in TOC");
    assertEquals(batch.nextToc["note.md"].digest, `d-note.md`, "digest from PrepFile");
});
