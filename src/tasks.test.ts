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
import { DEFAULT_SETTINGS, InfoFile } from "./types.ts";
import { computeDigest } from "./util.ts";
import { Extractor } from "./Archive.ts";


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

function text(bytes: Uint8Array<ArrayBuffer>): string {
    return new TextDecoder().decode(bytes);
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

Deno.test("detectChangedFiles: stat failures are skipped and logged", async () => {
    const messages: string[] = [];
    const vault: VaultReader = {
        normalizePath: (p: string) => p,
        isFileExists: async () => true,
        stat: async () => false,
        readBinary: async () => {
            throw new Error("readBinary should not be called when stat fails");
        },
    };

    const results = await collect(
        detectChangedFiles(
            false, false, mockProgress(), mockProgress(), () => {},
            {}, ["statless.md"], vault, "backups", (msg) => messages.push(msg), () => {}, () => {}, "/", baseSettings, today,
        ),
    );

    assertEquals(results.length, 0, "stat failure should not yield a file");
    assertEquals(messages, ["Archiving: Could not read stat statless.md"], "stat failure should be logged");
});

Deno.test("detectChangedFiles: readBinary failures are skipped and logged", async () => {
    const messages: string[] = [];
    const vault: VaultReader = {
        normalizePath: (p: string) => p,
        isFileExists: async () => true,
        stat: async () => ({ mtime: 1000 }),
        readBinary: async () => false,
    };

    const results = await collect(
        detectChangedFiles(
            false, false, mockProgress(), mockProgress(), () => {},
            {}, ["unreadable.md"], vault, "backups", (msg) => messages.push(msg), () => {}, () => {}, "/", baseSettings, today,
        ),
    );

    assertEquals(results.length, 0, "read failure should not yield a file");
    assertEquals(messages, ["Archiving: Could not read unreadable.md"], "read failure should be logged");
});

// ─────────────────────────────────────────────────────────────────────────────
// packBatches
// ─────────────────────────────────────────────────────────────────────────────

function emptyToc(): FileInfos {
    return {};
}

async function runBackupPipeline(
    files: Record<string, { content: ArrayBuffer; mtime: number }>,
    allFiles: string[],
    toc: FileInfos,
    makeZipName: (batchIndex: number) => string,
    processedAt: number,
) {
    return collect(
        packBatches(
            planBatches(
                detectChangedFiles(
                    false, false, mockProgress(), mockProgress(), () => {},
                    toc, allFiles, makeVault(files), "backups", () => {}, () => {}, () => {}, "/", baseSettings, today,
                ),
                100,
                0,
            ),
            makeZipName,
            toc,
            processedAt,
            () => {},
            mockProgress(),
            mockProgress(),
            JSON.stringify,
        ),
    );
}

async function extractZipText(zipData: Uint8Array<ArrayBuffer>): Promise<Record<string, string>> {
    const extracted: Record<string, string> = {};
    const extractor = new Extractor(
        () => true,
        async (filename, content) => {
            extracted[filename] = text(content);
        },
    );
    extractor.addZippedContent(zipData, true);
    await new Promise((res) => setTimeout(res, 100));
    return extracted;
}

function parseBackupInfo(text: string): FileInfos {
    const trimmed = text.trim();
    assert(trimmed.startsWith("```"), "backupinfo.md should start with a fenced block");
    assert(trimmed.endsWith("```"), "backupinfo.md should end with a fenced block");
    return JSON.parse(trimmed.slice(3, -3).trim()) as FileInfos;
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

Deno.test("backup pipeline: incremental runs handle add, modify, delete, same-mtime modify, and recreate", async () => {
    const baseMtime = new Date("2024-06-01T00:00:00Z").getTime();
    const initialVault = {
        "unchanged.md": { content: textBuffer("same content"), mtime: baseMtime },
        "modified.md": { content: textBuffer("old content"), mtime: baseMtime + 1000 },
        "same-time-modified.md": { content: textBuffer("same time old content"), mtime: baseMtime + 2000 },
        "deleted.md": { content: textBuffer("delete me"), mtime: baseMtime + 2000 },
    };

    const [firstBackup] = await runBackupPipeline(
        initialVault,
        ["unchanged.md", "modified.md", "same-time-modified.md", "deleted.md"],
        emptyToc(),
        () => "full-0.zip",
        10_000,
    );
    assert(firstBackup !== undefined, "first run should create a full backup");

    const incrementalVault = {
        "unchanged.md": { content: textBuffer("same content"), mtime: baseMtime },
        "modified.md": { content: textBuffer("new content"), mtime: baseMtime + 3000 },
        "same-time-modified.md": { content: textBuffer("same time new content"), mtime: baseMtime + 2000 },
        "added.md": { content: textBuffer("brand new"), mtime: baseMtime + 4000 },
    };

    const [secondBackup] = await runBackupPipeline(
        incrementalVault,
        ["unchanged.md", "modified.md", "same-time-modified.md", "added.md"],
        firstBackup.nextToc,
        () => "incremental-0.zip",
        20_000,
    );
    assert(secondBackup !== undefined, "second run should create an incremental backup");
    assertEquals(secondBackup.fileCount, 3, "second ZIP should contain only added and modified files");

    const extracted = await extractZipText(secondBackup.zipData);
    assertEquals(extracted["modified.md"], "new content", "modified file content should be archived");
    assertEquals(extracted["same-time-modified.md"], "same time new content", "same-mtime modified file content should be archived");
    assertEquals(extracted["added.md"], "brand new", "new file content should be archived");
    assert(!("unchanged.md" in extracted), "unchanged file should not be archived again");
    assert(!("deleted.md" in extracted), "deleted file should not be archived as content");
    assert(InfoFile in extracted, "incremental ZIP should include backupinfo.md");

    const nextToc = secondBackup.nextToc;
    assertEquals(parseBackupInfo(extracted[InfoFile]), nextToc, "backupinfo.md should match second run nextToc");
    assertEquals(nextToc["unchanged.md"].history.length, 1, "unchanged file history should not grow");
    assertEquals(nextToc["unchanged.md"].history[0].zipName, "full-0.zip", "unchanged file should still point to full backup");
    assertEquals(nextToc["modified.md"].missing, false, "modified file should not be marked missing");
    assertEquals(nextToc["modified.md"].history.length, 2, "modified file should get a second history entry");
    assertEquals(nextToc["modified.md"].history.at(-1)?.zipName, "incremental-0.zip", "modified history should point to incremental ZIP");
    assertEquals(nextToc["same-time-modified.md"].missing, false, "same-mtime modified file should not be marked missing");
    assertEquals(nextToc["same-time-modified.md"].history.length, 2, "same-mtime modified file should get a second history entry");
    assertEquals(
        nextToc["same-time-modified.md"].history.at(-1)?.zipName,
        "incremental-0.zip",
        "same-mtime modified history should point to incremental ZIP",
    );
    assertEquals(nextToc["added.md"].history.length, 1, "new file should get one history entry");
    assertEquals(nextToc["added.md"].history[0].zipName, "incremental-0.zip", "new file should point to incremental ZIP");
    assertEquals(nextToc["deleted.md"].missing, true, "deleted file should be marked missing");
    assertEquals(nextToc["deleted.md"].history.length, 2, "deleted file should get a missing history entry");
    assertEquals(nextToc["deleted.md"].history.at(-1)?.missing, true, "latest deleted history should be marked missing");
    assertEquals(nextToc["deleted.md"].history.at(-1)?.zipName, "incremental-0.zip", "deleted history should point to incremental ZIP");

    const recreatedVault = {
        "unchanged.md": { content: textBuffer("same content"), mtime: baseMtime },
        "modified.md": { content: textBuffer("new content"), mtime: baseMtime + 3000 },
        "same-time-modified.md": { content: textBuffer("same time new content"), mtime: baseMtime + 2000 },
        "added.md": { content: textBuffer("brand new"), mtime: baseMtime + 4000 },
        "deleted.md": { content: textBuffer("reborn"), mtime: baseMtime + 5000 },
    };

    const [thirdBackup] = await runBackupPipeline(
        recreatedVault,
        ["unchanged.md", "modified.md", "same-time-modified.md", "added.md", "deleted.md"],
        secondBackup.nextToc,
        () => "recreated-0.zip",
        30_000,
    );
    assert(thirdBackup !== undefined, "third run should create a backup for the recreated file");
    assertEquals(thirdBackup.fileCount, 1, "third ZIP should contain only the recreated file");

    const thirdExtracted = await extractZipText(thirdBackup.zipData);
    assertEquals(thirdExtracted["deleted.md"], "reborn", "recreated file content should be archived");
    assert(!("unchanged.md" in thirdExtracted), "unchanged file should not be archived in third run");
    assert(!("modified.md" in thirdExtracted), "previously modified file should not be archived again in third run");
    assert(!("same-time-modified.md" in thirdExtracted), "same-mtime modified file should not be archived again in third run");
    assert(!("added.md" in thirdExtracted), "previously added file should not be archived again in third run");

    const finalToc = thirdBackup.nextToc;
    assertEquals(parseBackupInfo(thirdExtracted[InfoFile]), finalToc, "backupinfo.md should match third run nextToc");
    assertEquals(finalToc["deleted.md"].missing, false, "recreated file should clear the missing flag");
    assertEquals(finalToc["deleted.md"].history.length, 3, "recreated file should keep full history");
    assertEquals(finalToc["deleted.md"].history.at(-1)?.missing, undefined, "latest recreated history should not be marked missing");
    assertEquals(finalToc["deleted.md"].history.at(-1)?.zipName, "recreated-0.zip", "recreated history should point to third ZIP");
    assertEquals(finalToc["deleted.md"].history.at(-1)?.digest, finalToc["deleted.md"].digest, "recreated latest history digest should match TOC digest");

    const noChangeBackups = await runBackupPipeline(
        recreatedVault,
        ["unchanged.md", "modified.md", "same-time-modified.md", "added.md", "deleted.md"],
        finalToc,
        () => "empty-0.zip",
        40_000,
    );
    assertEquals(noChangeBackups.length, 0, "no-change incremental run should not create a backup");
});
