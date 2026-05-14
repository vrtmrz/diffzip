import { Modal, Notice, TFile, stringifyYaml, type App } from "obsidian";
import { mount, unmount } from "svelte";
import { Archiver } from "./Archive.ts";
import { computeDigest, pieces, toArrayBuffer } from "./util.ts";
import { ProgressFragment } from "./ProgressFragment.ts";
import { confirmWithMessage } from "./dialog.ts";
import { InfoFile, type FileInfos } from "./types.ts";
import type DiffZipBackupPlugin from "../main.ts";
import SyncRemoteComponent from "./SyncRemote.svelte";
import {
    applySendBatchToToc,
    getAllowedActions,
    getDefaultAction,
    isActionAllowed,
    planSendBatches,
    type SyncAction,
    type SyncOperation,
    type TocUpdate,
} from "./SyncPlanner.ts";

export type { SyncAction, SyncOperation } from "./SyncPlanner.ts";

export type SyncItem = {
    filename: string;
    operation: SyncOperation;
    zipName: string;
    modified: string;
    action: SyncAction;
    allowedActions: SyncAction[];
    defaultAction: SyncAction;
};

const OP_ORDER: Record<SyncOperation, number> = {
    Conflict: 0,
    Add: 1,
    Updated: 2,
    Old: 3,
    Delete: 4,
    "Extra (Delete)": 5,
    Same: 6,
};

export class SyncRemoteDialog extends Modal {
    component?: ReturnType<typeof mount>;

    constructor(
        app: App,
        public plugin: DiffZipBackupPlugin,
    ) {
        super(app);
    }

    async onOpen() {
        const { contentEl } = this;
        this.titleEl.setText("Selective Sync Remote");
        contentEl.empty();

        const progress = new ProgressFragment({
            title: "Downloading remote backup info...",
            value: 0,
            total: 100,
        });
        contentEl.appendChild(progress.fragment);

        try {
            // Step 1: Load remote TOC
            const remoteToc: FileInfos = await this.plugin.loadTOC();

            // Step 2: Scan local vault with full digest computation
            progress.title = "Scanning local vault...";
            const allFiles = await this.plugin.getAllFiles();
            progress.total = allFiles.length + 5;
            progress.value = 5;

            const localFileMap = new Map<
                string,
                { digest: string; mtime: number }
            >();
            for (let i = 0; i < allFiles.length; i++) {
                const file = allFiles[i];
                progress.note = file;
                progress.value = i + 5;

                const localPath = this.plugin.vaultAccess.normalizePath(file);
                const stat = await this.plugin.vaultAccess.stat(localPath);
                const content =
                    await this.plugin.vaultAccess.readBinary(localPath);
                if (stat && content !== false) {
                    const digest = await computeDigest(
                        new Uint8Array(content),
                    );
                    localFileMap.set(file, { digest, mtime: stat.mtime });
                }
            }

            // Step 3: Compute diff
            progress.title = "Computing differences...";
            progress.value = allFiles.length + 5;

            const items: SyncItem[] = [];
            const pluginDir = this.plugin.manifest.dir;

            // Build ignore patterns when hidden folders are not included
            const ignorePatterns: string[] = [];
            if (!this.plugin.settings.includeHiddenFolder) {
                ignorePatterns.push(
                    "node_modules",
                    ".git",
                    this.plugin.app.vault.configDir + "/trash",
                    this.plugin.app.vault.configDir + "/workspace.json",
                    this.plugin.app.vault.configDir + "/workspace-mobile.json",
                );
            }

            const shouldIgnoreFile = (filename: string): boolean => {
                if (ignorePatterns.length === 0) return false;
                // Check if file matches any ignore pattern
                for (const pattern of ignorePatterns) {
                    if (filename.endsWith(pattern) || filename.startsWith(pattern + "/")) {
                        return true;
                    }
                    // Check for hidden files/folders in path
                    if (filename.split("/").some((part) => part.startsWith("."))) {
                        return true;
                    }
                }
                return false;
            };

            for (const [filename, fileInfo] of Object.entries(remoteToc)) {
                // Skip plugin own files (same as restoreVault)
                if (pluginDir && filename.startsWith(pluginDir)) continue;

                // Skip hidden files/folders when includeHiddenFolder is false
                if (shouldIgnoreFile(filename)) continue;

                const history = [...fileInfo.history].sort(
                    (a, b) =>
                        new Date(b.modified).getTime() -
                        new Date(a.modified).getTime(),
                );
                if (history.length === 0) continue;
                const latest = history[0];
                const isRemoteMissing = fileInfo.missing === true;
                const localInfo = localFileMap.get(filename);
                let operation: SyncOperation | undefined;

                if (isRemoteMissing) {
                    if (localInfo) {
                        operation = "Delete";
                    }
                } else if (!localInfo) {
                    operation = "Add";
                } else if (latest.digest === localInfo.digest) {
                    operation = "Same";
                } else {
                    const remoteMtime = new Date(latest.modified).getTime();
                    const localMtime = localInfo.mtime;
                    if (remoteMtime > localMtime) {
                        operation = "Updated";
                    } else if (remoteMtime < localMtime) {
                        operation = "Old";
                    } else {
                        // Same mtime, different digest → Conflict
                        operation = "Conflict";
                    }
                }

                if (operation) {
                    const allowedActions = getAllowedActions(operation);
                    const defaultAction = getDefaultAction(operation, {
                        destructiveDefaultsEnabled: this.plugin.settings.defaultDestructiveSyncActions,
                    });
                    const action = isActionAllowed(operation, defaultAction)
                        ? defaultAction
                        : "None";
                    items.push({
                        filename,
                        operation,
                        zipName: latest.zipName,
                        modified: latest.modified,
                        action,
                        allowedActions,
                        defaultAction,
                    });
                }
            }

            // Extra: local files not tracked by remote TOC at all
            for (const filename of localFileMap.keys()) {
                if (!(filename in remoteToc)) {
                    const operation: SyncOperation = "Extra (Delete)";
                    const allowedActions = getAllowedActions(operation);
                    const defaultAction = getDefaultAction(operation, {
                        destructiveDefaultsEnabled: this.plugin.settings.defaultDestructiveSyncActions,
                    });
                    const action = isActionAllowed(operation, defaultAction)
                        ? defaultAction
                        : "None";
                    items.push({
                        filename,
                        operation,
                        zipName: "",
                        modified: "",
                        action,
                        allowedActions,
                        defaultAction,
                    });
                }
            }

            items.sort((a, b) => {
                const oDiff = OP_ORDER[a.operation] - OP_ORDER[b.operation];
                return oDiff !== 0 ? oDiff : a.filename.localeCompare(b.filename);
            });

            // Phase 2: Show Svelte table
            contentEl.empty();
            this.component = mount(SyncRemoteComponent, {
                target: contentEl,
                props: {
                    initialItems: items,
                    onApply: async (updatedItems: SyncItem[]) => {
                        await this.applySync(updatedItems);
                    },
                    onCancel: () => this.close(),
                },
            });
        } catch (e) {
            this.close();
            new Notice(
                `Check and mirror remote failed: ${e instanceof Error ? e.message : String(e)}`,
            );
        }
    }

    async applySync(items: SyncItem[]) {
        const fetchItems = items.filter((i) => i.action === "Fetch");
        const sendItems = items.filter((i) => i.action === "Send");

        if (fetchItems.length === 0 && sendItems.length === 0) {
            this.close();
            new Notice("No sync action selected.");
            return;
        }

        const destructiveOps = items.filter(
            (i) =>
                i.action !== "None" &&
                ["Delete", "Extra (Delete)"].includes(i.operation),
        );

        if (destructiveOps.length > 0) {
            const APPLY = "Apply";
            const CANCEL = "Cancel";
            const msg = `**${destructiveOps.length}** destructive sync operation(s) are selected (Delete / Extra (Delete)).\n\nAre you sure you want to proceed?`;
            const result = await confirmWithMessage(
                this.plugin,
                "Confirm Apply",
                msg,
                [APPLY, CANCEL],
                CANCEL,
            );
            if (result !== APPLY) return;
        }

        this.close();

        let fetched = 0;
        let sent = 0;

        if (fetchItems.length > 0) {
            const fetchResult = await this.applyFetch(fetchItems);
            fetched = fetchResult.done;
            if (fetchResult.failed.length > 0) {
                const msg = `**${fetched - fetchResult.failed.length}** file(s) fetched successfully.\n\n**${fetchResult.failed.length}** file(s) failed:\n${fetchResult.failed.map((f) => `- ${f}`).join("\n")}\n\nSend phase was skipped because fetch failed.`;
                await confirmWithMessage(
                    this.plugin,
                    "Sync stopped by fetch errors",
                    msg,
                    ["Close"],
                    "Close",
                );
                return;
            }
        }

        if (sendItems.length > 0) {
            try {
                sent = await this.applySend(sendItems);
            } catch (e) {
                new Notice(
                    `Send phase failed: ${e instanceof Error ? e.message : String(e)}`,
                );
                return;
            }
        }

        new Notice(
            `Sync completed. Fetch: ${fetched} file(s), Send: ${sent} file(s).`,
        );
    }

    async applyFetch(fetchItems: SyncItem[]) {
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

        const totalOps =
            [...zipFileMap.values()].reduce((a, b) => a + b.length, 0) +
            deleteFiles.length;
        const progress = new ProgressFragment({
            title: "Mirroring remote...",
            value: 0,
            total: totalOps,
        });
        const progressNotice = new Notice(progress.fragment, 0);

        let done = 0;
        const failed: string[] = [];

        // Extract files from ZIPs (grouped by ZIP for efficiency)
        for (const [zipName, files] of zipFileMap) {
            progress.note = `Extracting ${zipName}`;
            try {
                await this.plugin.extract(zipName, files);
                done += files.length;
                progress.value = done;
            } catch (e) {
                failed.push(...files);
                this.plugin.logWrite(
                    `Failed to extract from ${zipName}: ${e}`,
                );
            }
        }

        // Move deleted/extra files to Obsidian trash
        for (const filename of deleteFiles) {
            progress.note = `Deleting ${filename}`;
            try {
                const abstractFile =
                    this.app.vault.getAbstractFileByPath(filename);
                if (abstractFile instanceof TFile) {
                    await this.app.vault.trash(abstractFile, false);
                }
                done++;
                progress.value = done;
            } catch (e) {
                failed.push(filename);
                this.plugin.logWrite(`Failed to delete ${filename}: ${e}`);
            }
        }

        progressNotice.hide();

        if (failed.length > 0) {
            const msg = `**${done - failed.length}** file(s) mirrored successfully.\n\n**${failed.length}** file(s) failed:\n${failed.map((f) => `- ${f}`).join("\n")}`;
            this.plugin.logWrite(msg);
        }

        return { done, failed };
    }

    makeSyncZipName(batchIndex: number): string {
        const today = new Date();
        const secondsInDay =
            ~~(today.getTime() / 1000 - today.getTimezoneOffset() * 60) % 86400;
        return `${today.getFullYear()}-${today.getMonth() + 1}-${today.getDate()}-${secondsInDay}-sync-${batchIndex + 1}.zip`;
    }

    async rollbackWrittenZipFiles(writtenFiles: string[]) {
        const failed: string[] = [];
        for (const path of writtenFiles) {
            const ok = await this.plugin.backups.deleteBinary(path);
            if (!ok) failed.push(path);
        }
        if (failed.length > 0) {
            this.plugin.logWrite(
                `Failed to rollback ${failed.length} ZIP file(s):\n${failed.join("\n")}`,
            );
        }
        return failed;
    }

    async writeSendZip(
        zipName: string,
        files: { filename: string; content: Uint8Array<ArrayBuffer>; mtime: number }[],
        toc: FileInfos,
    ) {
        const zip = new Archiver();
        for (const file of files) {
            zip.addFile(file.content, file.filename, { mtime: file.mtime });
        }

        const tocTimeStamp = new Date().getTime();
        zip.addTextFile(`\`\`\`\n${stringifyYaml(toc)}\n\`\`\`\n`, InfoFile, {
            mtime: tocTimeStamp,
        });

        const buf = await zip.finalize();
        const step =
            this.plugin.settings.maxSize / 1 == 0
                ? buf.byteLength + 1
                : (this.plugin.settings.maxSize / 1) * 1024 * 1024;
        let pieceCount = 0;
        if (buf.byteLength > step) pieceCount = 1;

        const writtenFiles: string[] = [];
        const chunks = pieces(buf, step);
        for (const chunk of chunks) {
            const outZipFile = this.plugin.backups.normalizePath(
                `${this.plugin.backupFolder}${this.plugin.sep}${zipName}${pieceCount == 0 ? "" : "." + `00${pieceCount}`.slice(-3)}`,
            );
            pieceCount++;
            const ok = await this.plugin.backups.writeBinary(
                outZipFile,
                toArrayBuffer(chunk),
            );
            if (!ok) {
                await this.rollbackWrittenZipFiles(writtenFiles);
                throw new Error(`Creating ${outZipFile} failed`);
            }
            writtenFiles.push(outZipFile);
        }

        return writtenFiles;
    }

    async applySend(sendItems: SyncItem[]) {
        const preparedFiles = [] as {
            filename: string;
            content: Uint8Array<ArrayBuffer>;
            digest: string;
            mtime: number;
            size: number;
        }[];
        const preparedMissing = [] as { filename: string; modifiedTime: number }[];

        for (const item of sendItems) {
            const normalized = this.plugin.vaultAccess.normalizePath(item.filename);
            const stat = await this.plugin.vaultAccess.stat(normalized);
            if (!stat) {
                preparedMissing.push({
                    filename: item.filename,
                    modifiedTime: Date.now(),
                });
                continue;
            }

            const content = await this.plugin.vaultAccess.readBinary(normalized);
            if (content === false) {
                throw new Error(`Could not read local file: ${item.filename}`);
            }
            const bytes = new Uint8Array(content);
            const digest = await computeDigest(bytes);
            preparedFiles.push({
                filename: item.filename,
                content: bytes,
                digest,
                mtime: stat.mtime,
                size: bytes.byteLength,
            });
        }

        const maxFilesInZip = this.plugin.settings.maxFilesInZip;
        const maxTotalSizeInZip =
            this.plugin.settings.maxTotalSizeInZip > 0
                ? this.plugin.settings.maxTotalSizeInZip * 1024 * 1024
                : 0;

        const { batches, oversizedFiles } = planSendBatches(
            preparedFiles.map((f) => ({ filename: f.filename, size: f.size })),
            maxFilesInZip,
            maxTotalSizeInZip,
        );

        if (oversizedFiles.length > 0) {
            this.plugin.logWrite(
                `⚠️ These files exceed max total source size in a single ZIP and will be placed in individual ZIPs:\n${oversizedFiles.join("\n")}`,
            );
        }

        const preparedFileByPath = new Map(
            preparedFiles.map((f) => [f.filename, f] as const),
        );

        const effectiveBatches =
            batches.length > 0 ? batches : [{ files: [], totalSize: 0 }];

        let toc = await this.plugin.loadTOC();
        let sentCount = 0;

        for (let index = 0; index < effectiveBatches.length; index++) {
            const batch = effectiveBatches[index];
            const zipName = this.makeSyncZipName(index);
            const processedAt = Date.now();
            const updates = [] as TocUpdate[];
            const zippedFiles = [] as {
                filename: string;
                content: Uint8Array<ArrayBuffer>;
                mtime: number;
            }[];

            for (const planned of batch.files) {
                const prepared = preparedFileByPath.get(planned.filename);
                if (!prepared) {
                    throw new Error(`Planned file is missing in preparation: ${planned.filename}`);
                }
                updates.push({
                    kind: "file",
                    filename: prepared.filename,
                    digest: prepared.digest,
                    mtime: prepared.mtime,
                });
                zippedFiles.push({
                    filename: prepared.filename,
                    content: prepared.content,
                    mtime: prepared.mtime,
                });
            }

            if (index === 0) {
                for (const missing of preparedMissing) {
                    updates.push({
                        kind: "missing",
                        filename: missing.filename,
                        modifiedTime: missing.modifiedTime,
                    });
                }
            }

            const nextToc = applySendBatchToToc(
                toc,
                updates,
                zipName,
                processedAt,
            ) satisfies FileInfos;

            const writtenFiles = await this.writeSendZip(zipName, zippedFiles, nextToc);
            const tocFilePath = this.plugin.backups.normalizePath(
                `${this.plugin.backupFolder}${this.plugin.sep}${InfoFile}`,
            );
            const tocSaved = await this.plugin.backups.writeTOC(
                tocFilePath,
                toArrayBuffer(
                    new TextEncoder().encode(`\`\`\`\n${stringifyYaml(nextToc)}\n\`\`\`\n`),
                ),
            );
            if (!tocSaved) {
                await this.rollbackWrittenZipFiles(writtenFiles);
                throw new Error(
                    `TOC update failed after writing ${zipName}. ZIP files were rolled back when possible.`,
                );
            }

            toc = nextToc;
            sentCount += updates.length;
        }

        return sentCount;
    }

    onClose() {
        if (this.component) {
            void unmount(this.component);
            this.component = undefined;
        }
        const { contentEl } = this;
        contentEl.empty();
    }
}
