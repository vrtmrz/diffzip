import { Modal, type App } from "obsidian";
import { mount, unmount } from "svelte";
import RestoreRevisionDialogComponent from "./RestoreRevisionDialog.svelte";
import type DiffZipBackupPlugin from "../main.ts";

export const VIEW_TYPE_RESTORE = "diffzip-view-restore";

export const LATEST = Number.MAX_SAFE_INTEGER;

export class RestoreDialog extends Modal {
    constructor(
        app: App,
        public plugin: DiffZipBackupPlugin
    ) {
        super(app);
    }

    component?: ReturnType<typeof mount>;

    async onOpen() {
        const toc = await this.plugin.loadTOC();

        const containerEl = this.modalEl;
        containerEl.empty();
        this.titleEl.setText("Restore (Revision Selector)");

        this.component = mount(RestoreRevisionDialogComponent, {
            target: containerEl,
            props: {
                plugin: this.plugin,
                toc,
                onCancel: () => this.close(),
                onApply: async (
                    selectedRevisions: Record<string, number>,
                    mode: "new" | "all" | "all-delete",
                    prefix: string,
                ) => {
                    this.close();
                    const onlyNew = mode === "new";
                    const skipDeleted = mode !== "all-delete";
                    await this.plugin.restoreVault(onlyNew, skipDeleted, selectedRevisions, prefix);
                },
            },
        });
        return await Promise.resolve();
    }

    async onClose() {
        if (this.component) {
            unmount(this.component);
            this.component = undefined;
        }
        return await Promise.resolve();
    }
}
