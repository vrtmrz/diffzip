import { Modal, Notice, TFile, stringifyYaml, type App } from "obsidian";
import { mount, unmount } from "svelte";
import { computeDigest } from "./util.ts";
import { ProgressFragment } from "./ProgressFragment.ts";
import { confirmWithMessage } from "./dialog.ts";
import { type FileInfos } from "./types.ts";
import type DiffZipBackupPlugin from "../main.ts";
import SyncRemoteComponent from "./SyncRemote.svelte";
import {
    buildSyncItems,
    type SyncItem,
    type SyncOperation,
} from "./SyncPlanner.ts";
import { executeFetch, executeSend } from "./SyncEngine.ts";

export type { SyncAction, SyncItem, SyncOperation } from "./SyncPlanner.ts";

declare const __DIFFZIP_DEBUG__: boolean;
const DEBUG_SYNC_LOG = __DIFFZIP_DEBUG__;

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

            const items = buildSyncItems(remoteToc, localFileMap, {
                destructiveDefaultsEnabled: this.plugin.settings.defaultDestructiveSyncActions,
                pluginDir: this.plugin.manifest.dir ?? undefined,
                ignoreHidden: !this.plugin.settings.includeHiddenFolder,
                ignorePatterns,
                mtimeToleranceMs: 2000,
                debugDiffToConsole: DEBUG_SYNC_LOG,
            });
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

    makeSyncZipName(batchIndex: number): string {
        const today = new Date();
        const secondsInDay =
            ~~(today.getTime() / 1000 - today.getTimezoneOffset() * 60) % 86400;
        return `${today.getFullYear()}-${today.getMonth() + 1}-${today.getDate()}-${secondsInDay}-sync-${batchIndex + 1}.zip`;
    }

    async applyFetch(fetchItems: SyncItem[]) {
        return await this.plugin.runWhileAwake("selective-sync-fetch", () => this.applyFetchWithoutWakeLock(fetchItems));
    }

    private async applyFetchWithoutWakeLock(fetchItems: SyncItem[]) {
        const totalOps = fetchItems.length;
        const progress = new ProgressFragment({
            title: "Mirroring remote...",
            value: 0,
            total: totalOps,
        });
        const progressNotice = new Notice(progress.fragment, 0);
        progressNotice.messageEl.classList.add("diffzip-progress-notice-message");
        let done = 0;

        const result = await executeFetch(
            fetchItems,
            { extract: (zipName, files) => this.plugin.extract(zipName, files) },
            {
                deleteLocal: async (filename) => {
                    const abstractFile = this.app.vault.getAbstractFileByPath(filename);
                    if (abstractFile instanceof TFile) {
                        await this.app.fileManager.trashFile(abstractFile);
                    }
                    return true;
                },
            },
            (note) => {
                progress.note = note;
                progress.value = ++done;
            },
            DEBUG_SYNC_LOG,
        );

        progressNotice.hide();
        if (result.failed.length > 0) {
            this.plugin.logWrite(
                `**${result.done - result.failed.length}** file(s) mirrored.\n**${result.failed.length}** failed:\n${result.failed.map((f) => `- ${f}`).join("\n")}`,
            );
        }
        return result;
    }

    async applySend(sendItems: SyncItem[]) {
        return await this.plugin.runWhileAwake("selective-sync-send", async () => {
            const { sentCount } = await executeSend(
                sendItems,
                this.plugin.vaultAccess,
                this.plugin.backups,
                () => this.plugin.loadTOC(),
                (i) => this.makeSyncZipName(i),
                {
                    backupFolder: this.plugin.backupFolder,
                    sep: this.plugin.sep,
                    maxFilesInZip: this.plugin.settings.maxFilesInZip,
                    maxTotalSizeInZip:
                        this.plugin.settings.maxTotalSizeInZip > 0
                            ? this.plugin.settings.maxTotalSizeInZip * 1024 * 1024
                            : 0,
                    maxSize:
                        this.plugin.settings.maxSize > 0
                            ? this.plugin.settings.maxSize * 1024 * 1024
                            : 0,
                    serializeYaml: stringifyYaml,
                    debugExecutionToConsole: DEBUG_SYNC_LOG,
                },
            );
            return sentCount;
        });
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
