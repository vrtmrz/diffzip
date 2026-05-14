/**
 * SyncEngine: Obsidian-agnostic sync execution logic.
 * Accepts duck-typed adapters so unit tests can use in-memory implementations.
 */

import { Archiver } from "./Archive.ts";
import { computeDigest, pieces, toArrayBuffer } from "./util.ts";
import { InfoFile, type FileInfos } from "./types.ts";
import {
    applySendBatchToToc,
    planSendBatches,
    type SyncItem,
    type TocMap,
    type TocUpdate,
} from "./SyncPlanner.ts";

// ── Minimal adapters ───────────────────────────────────────────────

/** Local vault read/delete access */
export interface VaultReadAdapter {
    normalizePath(path: string): string;
    stat(path: string): Promise<{ mtime: number } | false>;
    readBinary(path: string): Promise<ArrayBuffer | false>;
}

/** Local vault write/delete access (for Fetch → delete local file) */
export interface VaultDeleteAdapter {
    deleteLocal(path: string): Promise<boolean>;
}

/** Remote backup storage access */
export interface BackupStorageAdapter {
    normalizePath(path: string): string;
    writeBinary(path: string, data: ArrayBuffer): Promise<boolean>;
    writeTOC(path: string, data: ArrayBuffer): Promise<boolean>;
    deleteBinary(path: string): Promise<boolean>;
}

/** ZIP extractor: given a zip name and list of files, writes extracted content to vault */
export interface ZipExtractAdapter {
    extract(zipName: string, files: string[]): Promise<void>;
}

export type SyncEngineOptions = {
    backupFolder: string;
    sep: string;
    maxFilesInZip: number;
    maxTotalSizeInZip: number; // bytes (0 = unlimited)
    maxSize: number; // bytes for ZIP split (0 = no split)
    /** Serialize an object as YAML text. Defaults to JSON.stringify for testability. */
    serializeYaml?: (obj: unknown) => string;
};

// ── executeFetch ───────────────────────────────────────────────────

export type FetchResult = {
    done: number;
    failed: string[];
};

export async function executeFetch(
    fetchItems: SyncItem[],
    extractor: ZipExtractAdapter,
    vaultDelete: VaultDeleteAdapter,
    onProgress?: (note: string) => void,
): Promise<FetchResult> {
    const zipFileMap = new Map<string, string[]>();
    const deleteFiles: string[] = [];

    for (const item of fetchItems) {
        if (item.operation === "Delete") {
            deleteFiles.push(item.filename);
        } else {
            const arr = zipFileMap.get(item.zipName) ?? [];
            arr.push(item.filename);
            zipFileMap.set(item.zipName, arr);
        }
    }

    let done = 0;
    const failed: string[] = [];

    for (const [zipName, files] of zipFileMap) {
        onProgress?.(`Extracting ${zipName}`);
        try {
            await extractor.extract(zipName, files);
            done += files.length;
        } catch (e) {
            failed.push(...files);
        }
    }

    for (const filename of deleteFiles) {
        onProgress?.(`Deleting ${filename}`);
        try {
            await vaultDelete.deleteLocal(filename);
            done++;
        } catch {
            failed.push(filename);
        }
    }

    return { done, failed };
}

// ── executeSend ────────────────────────────────────────────────────

export type SendResult = {
    sentCount: number;
    oversizedFiles: string[];
};

export async function executeSend(
    sendItems: SyncItem[],
    vault: VaultReadAdapter,
    backup: BackupStorageAdapter,
    loadToc: () => Promise<TocMap>,
    makeZipName: (batchIndex: number) => string,
    options: SyncEngineOptions,
    onProgress?: (note: string) => void,
): Promise<SendResult> {
    type PreparedFile = {
        filename: string;
        content: Uint8Array<ArrayBuffer>;
        digest: string;
        mtime: number;
        size: number;
    };

    const preparedFiles: PreparedFile[] = [];
    const preparedMissing: { filename: string; modifiedTime: number }[] = [];

    for (const item of sendItems) {
        const normalized = vault.normalizePath(item.filename);
        const stat = await vault.stat(normalized);
        if (!stat) {
            preparedMissing.push({ filename: item.filename, modifiedTime: Date.now() });
            continue;
        }
        const content = await vault.readBinary(normalized);
        if (content === false) throw new Error(`Could not read local file: ${item.filename}`);
        const bytes = new Uint8Array(content as ArrayBuffer);
        const digest = await computeDigest(bytes);
        preparedFiles.push({ filename: item.filename, content: bytes, digest, mtime: stat.mtime, size: bytes.byteLength });
    }

    const maxTotalSizeInZip = options.maxTotalSizeInZip;
    const { batches, oversizedFiles } = planSendBatches(
        preparedFiles.map((f) => ({ filename: f.filename, size: f.size })),
        options.maxFilesInZip,
        maxTotalSizeInZip,
    );
    if (oversizedFiles.length > 0) {
        console.warn(`⚠️ Oversized files placed in solo ZIPs: ${oversizedFiles.join(", ")}`);
    }

    const preparedFileByPath = new Map(preparedFiles.map((f) => [f.filename, f] as const));
    const effectiveBatches = batches.length > 0 ? batches : [{ files: [], totalSize: 0 }];

    let toc = await loadToc();
    let sentCount = 0;

    for (let index = 0; index < effectiveBatches.length; index++) {
        const batch = effectiveBatches[index];
        const zipName = makeZipName(index);
        const processedAt = Date.now();
        const updates: TocUpdate[] = [];
        const zippedFiles: { filename: string; content: Uint8Array<ArrayBuffer>; mtime: number }[] = [];

        for (const planned of batch.files) {
            const prepared = preparedFileByPath.get(planned.filename);
            if (!prepared) throw new Error(`Planned file missing in preparation: ${planned.filename}`);
            updates.push({ kind: "file", filename: prepared.filename, digest: prepared.digest, mtime: prepared.mtime });
            zippedFiles.push({ filename: prepared.filename, content: prepared.content, mtime: prepared.mtime });
        }

        if (index === 0) {
            for (const missing of preparedMissing) {
                updates.push({ kind: "missing", filename: missing.filename, modifiedTime: missing.modifiedTime });
            }
        }

        const nextToc = applySendBatchToToc(toc, updates, zipName, processedAt) satisfies TocMap;

        // Write ZIP (with splitting)
        const writtenFiles = await _writeSendZip(
            zipName, zippedFiles, nextToc as FileInfos,
            backup, options, onProgress,
        );

        // Persist TOC
        const tocFilePath = backup.normalizePath(
            `${options.backupFolder}${options.sep}${InfoFile}`,
        );
        const tocSaved = await backup.writeTOC(
            tocFilePath,
            toArrayBuffer(new TextEncoder().encode(`\`\`\`\n${(options.serializeYaml ?? JSON.stringify)(nextToc)}\n\`\`\`\n`)),
        );
        if (!tocSaved) {
            await _rollback(writtenFiles, backup);
            throw new Error(`TOC update failed after writing ${zipName}. ZIP files rolled back.`);
        }

        toc = nextToc;
        sentCount += updates.length;
    }

    return { sentCount, oversizedFiles };
}

// ── Internal helpers ───────────────────────────────────────────────

async function _writeSendZip(
    zipName: string,
    files: { filename: string; content: Uint8Array<ArrayBuffer>; mtime: number }[],
    toc: FileInfos,
    backup: BackupStorageAdapter,
    options: SyncEngineOptions,
    onProgress?: (note: string) => void,
): Promise<string[]> {
    const zip = new Archiver();
    for (const file of files) {
        zip.addFile(file.content, file.filename, { mtime: file.mtime });
    }
    const serializeYaml = options.serializeYaml ?? JSON.stringify;
    zip.addTextFile(`\`\`\`\n${serializeYaml(toc)}\n\`\`\`\n`, InfoFile, { mtime: Date.now() });
    const buf = await zip.finalize();

    const step = options.maxSize <= 0 ? buf.byteLength + 1 : options.maxSize;
    let pieceCount = 0;
    if (buf.byteLength > step) pieceCount = 1;

    const writtenFiles: string[] = [];
    const chunks = pieces(buf, step);
    for (const chunk of chunks) {
        const outPath = backup.normalizePath(
            `${options.backupFolder}${options.sep}${zipName}${pieceCount === 0 ? "" : "." + `00${pieceCount}`.slice(-3)}`,
        );
        pieceCount++;
        onProgress?.(`Writing ${outPath}`);
        const ok = await backup.writeBinary(outPath, toArrayBuffer(chunk));
        if (!ok) {
            await _rollback(writtenFiles, backup);
            throw new Error(`Creating ${outPath} failed`);
        }
        writtenFiles.push(outPath);
    }
    return writtenFiles;
}

async function _rollback(writtenFiles: string[], backup: BackupStorageAdapter): Promise<void> {
    for (const path of writtenFiles) {
        await backup.deleteBinary(path);
    }
}
