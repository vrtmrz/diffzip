import { Modal, Notice, TFile, type App } from "obsidian";
import { mount, unmount } from "svelte";
import { computeDigest } from "./util.ts";
import { ProgressFragment } from "./ProgressFragment.ts";
import { confirmWithMessage } from "./dialog.ts";
import type { FileInfos } from "./types.ts";
import type DiffZipBackupPlugin from "../main.ts";
import SyncRemoteComponent from "./SyncRemote.svelte";

export type SyncOperation =
    | "Add"
    | "Update"
    | "Revert"
    | "Conflict"
    | "Delete"
    | "Extra (Delete)"
    | "Same";

export type SyncItem = {
    filename: string;
    operation: SyncOperation;
    zipName: string;
    modified: string;
    checked: boolean;
};

const OP_ORDER: Record<SyncOperation, number> = {
    Conflict: 0,
    Add: 1,
    Update: 2,
    Revert: 3,
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
        this.titleEl.setText("Selective Apply Remote");
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

            for (const [filename, fileInfo] of Object.entries(remoteToc)) {
                // Skip plugin own files (same as restoreVault)
                if (pluginDir && filename.startsWith(pluginDir)) continue;

                const history = [...fileInfo.history].sort(
                    (a, b) =>
                        new Date(b.modified).getTime() -
                        new Date(a.modified).getTime(),
                );
                if (history.length === 0) continue;
                const latest = history[0];
                const isRemoteMissing = fileInfo.missing === true;
                const localInfo = localFileMap.get(filename);

                if (isRemoteMissing) {
                    if (localInfo) {
                        items.push({
                            filename,
                            operation: "Delete",
                            zipName: latest.zipName,
                            modified: latest.modified,
                            checked: true,
                        });
                    }
                } else if (!localInfo) {
                    items.push({
                        filename,
                        operation: "Add",
                        zipName: latest.zipName,
                        modified: latest.modified,
                        checked: true,
                    });
                } else if (latest.digest === localInfo.digest) {
                    items.push({
                        filename,
                        operation: "Same",
                        zipName: "",
                        modified: latest.modified,
                        checked: false,
                    });
                } else {
                    const remoteMtime = new Date(latest.modified).getTime();
                    const localMtime = localInfo.mtime;
                    if (remoteMtime > localMtime) {
                        items.push({
                            filename,
                            operation: "Update",
                            zipName: latest.zipName,
                            modified: latest.modified,
                            checked: true,
                        });
                    } else if (remoteMtime < localMtime) {
                        items.push({
                            filename,
                            operation: "Revert",
                            zipName: latest.zipName,
                            modified: latest.modified,
                            checked: true,
                        });
                    } else {
                        // Same mtime, different digest → Conflict
                        items.push({
                            filename,
                            operation: "Conflict",
                            zipName: latest.zipName,
                            modified: latest.modified,
                            checked: false,
                        });
                    }
                }
            }

            // Extra: local files not tracked by remote TOC at all
            for (const filename of localFileMap.keys()) {
                if (!(filename in remoteToc)) {
                    items.push({
                        filename,
                        operation: "Extra (Delete)",
                        zipName: "",
                        modified: "",
                        checked: false,
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
                    onApply: async (checkedItems: SyncItem[]) => {
                        await this.applySync(checkedItems);
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

    async applySync(checkedItems: SyncItem[]) {
        const destructiveOps = checkedItems.filter((i) =>
            ["Delete", "Revert", "Extra", "Conflict"].includes(i.operation),
        );

        if (destructiveOps.length > 0) {
            const APPLY = "Apply";
            const CANCEL = "Cancel";
            const msg = `**${destructiveOps.length}** destructive operation(s) are selected (Delete / Revert / Extra / Conflict).\n\nAre you sure you want to proceed?`;
            const result = await confirmWithMessage(
                this.plugin,
                "Confirm Apply",
                msg,
                [APPLY, CANCEL],
                CANCEL,
            );
            if (result !== APPLY) return;
        }

        // Group files by ZIP for efficient extraction
        const zipFileMap = new Map<string, string[]>();
        const deleteFiles: string[] = [];
        for (const item of checkedItems) {
            if (item.operation === "Delete" || item.operation === "Extra (Delete)") {
                deleteFiles.push(item.filename);
            } else {
                const arr = zipFileMap.get(item.zipName) ?? [];
                arr.push(item.filename);
                zipFileMap.set(item.zipName, arr);
            }
        }

        this.close();

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
            await confirmWithMessage(
                this.plugin,
                "Mirror completed with errors",
                msg,
                ["Close"],
                "Close",
            );
        } else {
            new Notice(
                `${done} file${done !== 1 ? "s" : ""} mirrored successfully.`,
            );
        }
    }

    onClose() {
        if (this.component) {
            unmount(this.component);
            this.component = undefined;
        }
        const { contentEl } = this;
        contentEl.empty();
    }
}
