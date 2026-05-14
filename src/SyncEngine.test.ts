/**
 * SyncEngine integration tests using in-memory adapters.
 * Tests cover: buildSyncItems diff logic, executeSend, executeFetch,
 * "Sync" (non-destructive defaults) and "Sync W/ Deletion" (destructive defaults).
 */
// Polyfill: Obsidian provides `window`, but Deno does not.
// Archive.ts uses `window.setTimeout`, so we patch it here before importing.
if (typeof window === "undefined") {
    (globalThis as unknown as Record<string, unknown>).window = globalThis;
    (globalThis as unknown as Record<string, unknown>).activeWindow = globalThis;
}

import {
    buildSyncItems,
    type TocMap,
} from "./SyncPlanner.ts";
import {
    executeFetch,
    executeSend,
    type BackupStorageAdapter,
    type SyncEngineOptions,
    type VaultDeleteAdapter,
    type VaultReadAdapter,
    type ZipExtractAdapter,
} from "./SyncEngine.ts";
import type { SyncItem } from "./SyncPlanner.ts";

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

// ── In-memory adapters ─────────────────────────────────────────────

/** In-memory vault: filename → {content, mtime} */
class MemoryVault implements VaultReadAdapter, VaultDeleteAdapter {
    files = new Map<string, { content: Uint8Array; mtime: number }>();

    addFile(path: string, text: string, mtime = 1000) {
        this.files.set(path, { content: new TextEncoder().encode(text), mtime });
    }

    normalizePath(path: string) { return path; }

    async stat(path: string) {
        const f = this.files.get(path);
        return f ? { mtime: f.mtime } : false as false;
    }

    async readBinary(path: string): Promise<ArrayBuffer | false> {
        const f = this.files.get(path);
        return f ? f.content.buffer as ArrayBuffer : false;
    }

    async deleteLocal(path: string) {
        return this.files.delete(path);
    }
}

/** In-memory backup storage */
class MemoryBackup implements BackupStorageAdapter {
    bins = new Map<string, ArrayBuffer>();
    toc: ArrayBuffer | null = null;

    normalizePath(path: string) { return path; }

    async writeBinary(path: string, data: ArrayBuffer) {
        this.bins.set(path, data);
        return true;
    }

    async writeTOC(_path: string, data: ArrayBuffer) {
        this.toc = data;
        return true;
    }

    async deleteBinary(path: string) {
        return this.bins.delete(path);
    }
}

/** In-memory zip extractor */
class MemoryExtractor implements ZipExtractAdapter {
    extractCalls: { zipName: string; files: string[] }[] = [];
    vault: MemoryVault;
    zipContents: Map<string, Map<string, string>>;

    constructor(vault: MemoryVault, zipContents: Map<string, Map<string, string>>) {
        this.vault = vault;
        this.zipContents = zipContents;
    }

    async extract(zipName: string, files: string[]) {
        this.extractCalls.push({ zipName, files });
        const contents = this.zipContents.get(zipName);
        if (!contents) throw new Error(`ZIP not found: ${zipName}`);
        for (const filename of files) {
            const text = contents.get(filename);
            if (text !== undefined) this.vault.addFile(filename, text, 2000);
        }
    }
}

const defaultOptions: SyncEngineOptions = {
    backupFolder: "backup",
    sep: "/",
    maxFilesInZip: 100,
    maxTotalSizeInZip: 0,
    maxSize: 0,
};

// 2023-01-01T00:00:00Z in ms — within fflate's 1980-2099 range
const BASE_MTIME = 1672531200000;

function makeTocEntry(filename: string, zipName: string, digest: string, mtime: number, missing = false): TocMap[string] {
    return {
        filename,
        digest: missing ? "" : digest,
        mtime,
        missing,
        history: [{ zipName, modified: new Date(mtime).toISOString(), digest: missing ? "" : digest }],
    };
}

let batchCounter = 0;
function makeZipName(i: number) {
    return `sync-${++batchCounter}-${i}.zip`;
}

// ── buildSyncItems tests ───────────────────────────────────────────

Deno.test("buildSyncItems: detects Add, Same, Updated, Old, Conflict, Delete, Extra", () => {
    batchCounter = 0;
    const remoteToc: TocMap = {
        "add.md":      makeTocEntry("add.md",      "r1.zip", "digest-add",      BASE_MTIME),
        "same.md":     makeTocEntry("same.md",     "r1.zip", "digest-same",     BASE_MTIME),
        "updated.md":  makeTocEntry("updated.md",  "r1.zip", "digest-updated",  BASE_MTIME + 2000), // remote newer
        "old.md":      makeTocEntry("old.md",      "r1.zip", "digest-old",      BASE_MTIME - 500),  // remote older
        "conflict.md": makeTocEntry("conflict.md", "r1.zip", "digest-conflict", BASE_MTIME), // same mtime, different digest
        "deleted.md":  makeTocEntry("deleted.md",  "r1.zip", "digest-deleted",  BASE_MTIME, true), // missing in remote
    };

    const localFileMap = new Map([
        ["same.md",     { digest: "digest-same",     mtime: BASE_MTIME }],
        ["updated.md",  { digest: "digest-local",    mtime: BASE_MTIME }],       // local older
        ["old.md",      { digest: "digest-local",    mtime: BASE_MTIME + 1000 }], // local newer
        ["conflict.md", { digest: "digest-local",    mtime: BASE_MTIME }],       // same mtime, diff digest
        ["deleted.md",  { digest: "digest-deleted",  mtime: BASE_MTIME }],       // exists locally but remote says deleted
        ["extra.md",    { digest: "digest-extra",    mtime: BASE_MTIME }],       // only local
    ]);

    const items = buildSyncItems(remoteToc, localFileMap, { destructiveDefaultsEnabled: false });
    const byOp = Object.fromEntries(items.map((i) => [i.filename, i.operation]));

    assertEquals(byOp["add.md"],      "Add",           "Not in local → Add");
    assertEquals(byOp["same.md"],     "Same",          "Same digest → Same");
    assertEquals(byOp["updated.md"],  "Updated",       "Remote newer → Updated");
    assertEquals(byOp["old.md"],      "Old",           "Local newer → Old");
    assertEquals(byOp["conflict.md"], "Conflict",      "Same mtime, diff digest → Conflict");
    assertEquals(byOp["deleted.md"],  "Delete",        "Remote missing=true, local exists → Delete");
    assertEquals(byOp["extra.md"],    "Extra (Delete)", "Only in local → Extra (Delete)");
});

Deno.test("buildSyncItems: ignoreHidden=true filters dotfiles and patterns", () => {
    const remoteToc: TocMap = {
        "visible.md": makeTocEntry("visible.md", "r.zip", "d1", BASE_MTIME),
        ".hidden.md": makeTocEntry(".hidden.md", "r.zip", "d2", BASE_MTIME),
        ".git/config": makeTocEntry(".git/config", "r.zip", "d3", BASE_MTIME),
    };
    const localFileMap = new Map([
        ["visible.md",   { digest: "x", mtime: BASE_MTIME }],
        [".hidden.md",   { digest: "x", mtime: BASE_MTIME }],
        [".git/config",  { digest: "x", mtime: BASE_MTIME }],
        [".extra-local", { digest: "x", mtime: BASE_MTIME }],
    ]);

    const items = buildSyncItems(remoteToc, localFileMap, {
        destructiveDefaultsEnabled: false,
        ignoreHidden: true,
        ignorePatterns: [".git"],
    });

    const names = items.map((i) => i.filename);
    assert(names.includes("visible.md"), "visible.md should appear");
    assert(!names.includes(".hidden.md"), ".hidden.md should be filtered");
    assert(!names.includes(".git/config"), ".git/* should be filtered");
    assert(!names.includes(".extra-local"), ".extra-local should be filtered");
});

// ── executeSend tests ──────────────────────────────────────────────

Deno.test("executeSend: writes ZIP and TOC to backup, returns sentCount", async () => {
    batchCounter = 0;
    const vault = new MemoryVault();
    vault.addFile("note.md", "Hello World", BASE_MTIME);

    const backup = new MemoryBackup();

    const sendItems: SyncItem[] = [{
        filename: "note.md",
        operation: "Old",
        zipName: "",
        modified: "",
        action: "Send",
        allowedActions: ["None", "Fetch", "Send"],
        defaultAction: "Send",
    }];

    const initialToc: TocMap = {};

    const result = await executeSend(
        sendItems, vault, backup,
        async () => initialToc,
        makeZipName,
        defaultOptions,
    );

    assertEquals(result.sentCount, 1, "Should have sent 1 file");
    assert(backup.bins.size >= 1, "Should have written at least one ZIP");
    assert(backup.toc !== null, "TOC should have been written");
});

Deno.test("executeSend: multiple files split into batches when maxFilesInZip=1", async () => {
    batchCounter = 0;
    const vault = new MemoryVault();
    vault.addFile("a.md", "AAA", BASE_MTIME);
    vault.addFile("b.md", "BBB", BASE_MTIME + 1000);
    vault.addFile("c.md", "CCC", BASE_MTIME + 2000);

    const backup = new MemoryBackup();

    const sendItems: SyncItem[] = ["a.md", "b.md", "c.md"].map((f) => ({
        filename: f,
        operation: "Old" as const,
        zipName: "",
        modified: "",
        action: "Send" as const,
        allowedActions: ["None", "Fetch", "Send"] as const,
        defaultAction: "Send" as const,
    }));

    const result = await executeSend(
        sendItems, vault, backup,
        async () => ({}),
        makeZipName,
        { ...defaultOptions, maxFilesInZip: 1 },
    );

    assertEquals(result.sentCount, 3, "Should have sent 3 files");
    // 3 files with maxFilesInZip=1 → 3 separate ZIPs
    assert(backup.bins.size >= 3, "Should have written 3 ZIPs");
});

// ── executeFetch tests ─────────────────────────────────────────────

Deno.test("executeFetch: extracts files from remote ZIP to vault", async () => {
    const vault = new MemoryVault();
    const zipContents = new Map([
        ["r1.zip", new Map([["note.md", "Remote content"]])],
    ]);
    const extractor = new MemoryExtractor(vault, zipContents);
    const deleteAdapter: VaultDeleteAdapter = { deleteLocal: async () => true };

    const fetchItems: SyncItem[] = [{
        filename: "note.md",
        operation: "Add",
        zipName: "r1.zip",
        modified: new Date(2000).toISOString(),
        action: "Fetch",
        allowedActions: ["None", "Fetch"],
        defaultAction: "Fetch",
    }];

    const result = await executeFetch(fetchItems, extractor, deleteAdapter);

    assertEquals(result.done, 1, "Should have fetched 1 file");
    assertEquals(result.failed.length, 0, "Should have no failures");
    assertEquals(extractor.extractCalls.length, 1, "Should have called extract once");
    const restored = vault.files.get("note.md");
    assert(restored !== undefined, "note.md should be in vault after fetch");
    assertEquals(
        new TextDecoder().decode(restored!.content),
        "Remote content",
        "Content should match remote",
    );
});

Deno.test("executeFetch: deletes local file for Delete operation", async () => {
    const vault = new MemoryVault();
    vault.addFile("obsolete.md", "Old data", BASE_MTIME);

    const extractor = new MemoryExtractor(vault, new Map());
    const deleteAdapter: VaultDeleteAdapter = { deleteLocal: async (p) => vault.deleteLocal(p) };

    const fetchItems: SyncItem[] = [{
        filename: "obsolete.md",
        operation: "Delete",
        zipName: "",
        modified: "",
        action: "Fetch",
        allowedActions: ["None", "Fetch", "Send"],
        defaultAction: "Fetch",
    }];

    const result = await executeFetch(fetchItems, extractor, deleteAdapter);

    assertEquals(result.done, 1, "Should have processed 1 file");
    assertEquals(result.failed.length, 0, "Should have no failures");
    assert(!vault.files.has("obsolete.md"), "obsolete.md should be deleted from vault");
});

// ── Sync vs Sync W/ Deletion behaviour ────────────────────────────

Deno.test("Sync (non-destructive): Delete and Extra default to None", () => {
    const remoteToc: TocMap = {
        "update.md": makeTocEntry("update.md", "r.zip", "remote-d", BASE_MTIME + 2000),
        "deleted.md": makeTocEntry("deleted.md", "r.zip", "del-d", BASE_MTIME, true),
    };
    const localFileMap = new Map([
        ["update.md",  { digest: "local-d", mtime: BASE_MTIME }],
        ["deleted.md", { digest: "del-d",   mtime: BASE_MTIME }],
        ["extra.md",   { digest: "extra-d", mtime: BASE_MTIME }],
    ]);

    const items = buildSyncItems(remoteToc, localFileMap, { destructiveDefaultsEnabled: false });

    const byFile = Object.fromEntries(items.map((i) => [i.filename, i]));
    assertEquals(byFile["update.md"].defaultAction,  "Fetch", "Updated → default Fetch");
    assertEquals(byFile["deleted.md"].defaultAction, "None",  "Delete → default None (non-destructive)");
    assertEquals(byFile["extra.md"].defaultAction,   "None",  "Extra → default None (non-destructive)");
});

Deno.test("Sync W/ Deletion (destructive): Delete→Fetch, Extra→Send", () => {
    const remoteToc: TocMap = {
        "deleted.md": makeTocEntry("deleted.md", "r.zip", "del-d", BASE_MTIME, true),
    };
    const localFileMap = new Map([
        ["deleted.md", { digest: "del-d",   mtime: BASE_MTIME }],
        ["extra.md",   { digest: "extra-d", mtime: BASE_MTIME }],
    ]);

    const items = buildSyncItems(remoteToc, localFileMap, { destructiveDefaultsEnabled: true });

    const byFile = Object.fromEntries(items.map((i) => [i.filename, i]));
    assertEquals(byFile["deleted.md"].defaultAction, "Fetch", "Delete → Fetch when destructive enabled");
    assertEquals(byFile["extra.md"].defaultAction,   "Send",  "Extra → Send when destructive enabled");
});
