import { Archiver } from "./Archive.ts";
/** Minimal progress-reporting interface used by the generator functions. */
export interface ProgressReporter {
    total: number;
    value: number;
    note: string;
    isCancelled: boolean;
}
import { applySendBatchToToc, type TocUpdate } from "./SyncPlanner.ts";
import { type DiffZipBackupSettings, type FileInfos, InfoFile, type XByteArray } from "./types.ts";
import { computeDigest, ellipsisMiddle } from "./util.ts";

/** Minimal vault-access interface used by {@link detectChangedFiles}. */
export interface VaultReader {
    normalizePath(path: string): string;
    isFileExists(path: string): Promise<boolean>;
    stat(path: string): Promise<false | { mtime: number }>;
    readBinary(path: string): Promise<ArrayBuffer | false>;
}
export type PrepFile = { filename: string; content: XByteArray; digest: string; mtime: number; size: number };
export type PlannedBatch = {
    files: PrepFile[];
    missingUpdates: TocUpdate[];
};
export type ArchivedBatch = {
    zipName: string;
    zipData: XByteArray;
    nextToc: FileInfos;
    batchIndex: number;
    fileCount: number;
};
export async function* detectChangedFiles(
    onlyNew = false,
    skipDeleted: boolean = false,
    missingFileProgress: ProgressReporter,
    checkingProgress: ProgressReporter,
    throwIfCancelled: () => void,
    toc: FileInfos,
    allFiles: string[],
    vaultAccess: VaultReader,
    backupFolder: string,
    logMessage: (msg: string, key?: string) => void,
    logWrite: (msg: string, key?: string) => void,
    log: (msg: string, key?: string) => void,
    sep: string,
    settings: DiffZipBackupSettings,
    today: Date,
): AsyncGenerator<PrepFile | TocUpdate, void, void> {
    // ── Phase 1: detect missing files ────────────────────────────────
    missingFileProgress.total = Object.keys(toc).length;
    for (const [filename, fileInfo] of Object.entries(toc)) {
        throwIfCancelled();
        try {
            if (fileInfo.missing) continue;
            if (!(await vaultAccess.isFileExists(vaultAccess.normalizePath(filename)))) {
                if (skipDeleted) continue;
                log(`File ${filename} is missing`);
                yield { kind: "missing", filename, modifiedTime: today.getTime() };
            }
        } finally {
            missingFileProgress.value++;
        }
    }

    // ── Phase 2: scan vault for changed files ─────────────────────────

    // const changedFiles: PrepFile[] = [];
    const normalFiles = allFiles.filter(
        (e) =>
            !e.startsWith(backupFolder + sep) && !e.startsWith(settings.restoreFolder + sep)
    );
    checkingProgress.total = normalFiles.length;
    for (const path of normalFiles) {
        throwIfCancelled();
        try {
            checkingProgress.note = `Processing ${ellipsisMiddle(path)}`;
            const stat = await vaultAccess.stat(path);
            throwIfCancelled();
            if (!stat) {
                logMessage(`Archiving: Could not read stat ${path}`);
                continue;
            }
            if (onlyNew && path in toc && stat.mtime <= toc[path].mtime) {
                logWrite(`${path} older than the last backup, skipping`);
                continue;
            }
            const content = await vaultAccess.readBinary(path);
            if (!content) {
                logMessage(`Archiving: Could not read ${path}`);
                continue;
            }
            const f = new Uint8Array(content);
            const digest = await computeDigest(f);
            if (path in toc && toc[path].digest === digest) {
                logWrite(`${path} Not changed`);
                continue;
            }
            // changedFiles.push({ filename: path, content: f, digest, mtime: stat.mtime, size: f.byteLength });
            yield { filename: path, content: f, digest, mtime: stat.mtime, size: f.byteLength }
        } finally {
            checkingProgress.value++;
        }
    }
}

/**
 * Generator that groups detected items into {@link PlannedBatch}es, respecting
 * maxFilesInZip and maxTotalSizeInZip limits.
 * MissingUpdates (TocUpdate) are accumulated and flushed with the first batch
 * they encounter (or in the final batch if no file limit was triggered).
 */
export async function* planBatches(
    source: AsyncGenerator<PrepFile | TocUpdate, void, void>,
    maxFilesInZip: number,
    maxTotalSizeInZip: number,
): AsyncGenerator<PlannedBatch, void, void> {
    const pendingMissing: TocUpdate[] = [];
    let current: PrepFile[] = [];
    let currentSize = 0;

    for await (const item of source) {
        if ("kind" in item) {
            // TocUpdate — buffer until attached to the next flushed batch
            pendingMissing.push(item);
            continue;
        }
        // Oversized file → solo batch (flush current first)
        if (maxTotalSizeInZip > 0 && item.size > maxTotalSizeInZip) {
            if (current.length > 0) {
                yield { files: current, missingUpdates: pendingMissing.splice(0) };
                current = [];
                currentSize = 0;
            }
            yield { files: [item], missingUpdates: pendingMissing.splice(0) };
            continue;
        }
        const exceedsCount = maxFilesInZip > 0 && current.length >= maxFilesInZip;
        const exceedsSize =
            maxTotalSizeInZip > 0 && current.length > 0 && currentSize + item.size > maxTotalSizeInZip;
        if (exceedsCount || exceedsSize) {
            yield { files: current, missingUpdates: pendingMissing.splice(0) };
            current = [];
            currentSize = 0;
        }
        current.push(item);
        currentSize += item.size;
    }
    // Final batch — also handles "only missing updates, no changed files" case
    if (current.length > 0 || pendingMissing.length > 0) {
        yield { files: current, missingUpdates: pendingMissing.splice(0) };
    }
}

/**
 * Generator that packs planned batches into ZIP archives, one batch at a time.
 *
 * Yields each finalized {@link ArchivedBatch} before advancing to the next.
 * This provides a natural BackPressure point: the consumer (upload) must call
 * `.next()` before the generator builds the next archive, enabling a
 * pipeline where archive N+1 is built concurrently while archive N is uploaded.
 */
export async function* packBatches(
    source: AsyncGenerator<PlannedBatch, void, void>,
    makeZipName: (batchIndex: number) => string,
    toc: FileInfos,
    processedAt: number,
    throwIfCancelled: () => void,
    fileArchivedProgress: ProgressReporter,
    fileProcessingProgress: ProgressReporter,
    stringifyYaml: (obj: unknown) => string
): AsyncGenerator<ArchivedBatch, void, void> {
    let currentToc = toc;
    let batchIndex = 0;
    fileArchivedProgress.total = 0;
    fileArchivedProgress.value = 0;

    for await (const planned of source) {
        throwIfCancelled();
        const zipName = makeZipName(batchIndex);
        const { files, missingUpdates } = planned;

        fileArchivedProgress.total += files.length;
        const updates: TocUpdate[] = [...missingUpdates];
        for (const f of files) {
            updates.push({ kind: "file", filename: f.filename, digest: f.digest, mtime: f.mtime });
        }
        const nextToc = applySendBatchToToc(currentToc, updates, zipName, processedAt);

        // Build ZIP
        const zip = new Archiver();
        fileProcessingProgress.isCancelled = false;
        for (const file of files) {
            throwIfCancelled();
            fileArchivedProgress.note = `Archiving: ${ellipsisMiddle(file.filename)}`;
            zip.addFile(file.content, file.filename, { mtime: file.mtime }, (prog, total, finished) => {
                if (!finished) {
                    fileProcessingProgress.note = `Archiving: ${ellipsisMiddle(file.filename)}`;
                    fileProcessingProgress.total = total;
                    fileProcessingProgress.value = prog;
                } else {
                    fileArchivedProgress.value++;
                    fileArchivedProgress.note = `Archived: ${ellipsisMiddle(file.filename)}`;
                    fileProcessingProgress.note = "";
                    fileProcessingProgress.isCancelled = true;
                    fileProcessingProgress.total = 0;
                    fileProcessingProgress.value = 0;
                }
            });
        }
        throwIfCancelled();
        zip.addTextFile(`\`\`\`\n${stringifyYaml(nextToc)}\n\`\`\`\n`, InfoFile, { mtime: Date.now() });
        throwIfCancelled();
        const buf = await zip.finalize();

        // ── BackPressure: yield finished archive ─────────────────────────────
        // Consumer (upload) must call .next() to resume; that .next() also kicks
        // off building the NEXT batch — achieving pipeline parallelism.
        yield { zipName, zipData: buf, nextToc, batchIndex, fileCount: files.length };

        // Runs when consumer calls .next() (i.e. while next batch is building)
        currentToc = nextToc;
        batchIndex++;
    }
}
