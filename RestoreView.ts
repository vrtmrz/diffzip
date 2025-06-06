import {
    AbstractInputSuggest,
    Modal,
    prepareFuzzySearch,
    Setting,
    type App,
    type SearchResult,
    type TextComponent,
} from "obsidian";
import { mount, unmount } from "svelte";
import RestoreFilesComponent from "./RestoreFiles.svelte";
import type DiffZipBackupPlugin from "./main";
import { writable } from "svelte/store";

export const VIEW_TYPE_RESTORE = "diffzip-view-restore";

export type ListOperations = {
    expandFolder(name: string): void;
    expandAll(): void;
    remove(file: string): void;
    clearList(): void;
    fileSelected(file: string, timestamp: number): void;
};

export const LATEST = Number.MAX_SAFE_INTEGER;

export class RestoreDialog extends Modal {
    constructor(
        app: App,
        public plugin: DiffZipBackupPlugin
    ) {
        super(app);
    }

    component?: ReturnType<typeof mount>;
    currentFile: string = "";
    currentFiles: string[] = [];
    selectedTimestamps: { [file: string]: number } = {};

    async onOpen() {
        const fileList = writable<string[]>([]);
        const toc = await this.plugin.loadTOC();
        this.currentFiles = [];
        fileList.set(this.currentFiles);

        const selectedTimestamp = writable(this.selectedTimestamps);
        selectedTimestamp.subscribe((value) => {
            this.selectedTimestamps = value;
        });

        const containerEl = this.modalEl;
        containerEl.empty();

        function getFiles() {
            const filesAll = Object.keys(toc);
            const dirs = [...new Set(filesAll.map((e) => (e.split("/").slice(0, -1).join("/") + "/").slice(0, -1)))]
                .map((e) => e + "/*")
                .map((e) => (e == "/*" ? "*" : e));
            const files = [...dirs, ...filesAll].sort((a, b) => {
                const aDir = a.endsWith("*");
                const bDir = b.endsWith("*");
                if (aDir && !bDir) return -1;
                if (!aDir && bDir) return 1;
                return a.localeCompare(b);
            });
            return files;
        }

        const headerEl = containerEl.createDiv({ cls: "diffzip-dialog-header" });
        headerEl.createEl("h2", { text: "Restore" });

        let currentFileInput: TextComponent | undefined;
        new Setting(headerEl)
            .setName("Add to candidates")
            .setDesc("Select the backup file to restore")
            .addText((text) => {
                text.setPlaceholder("folder/a.md")
                    .setValue(this.currentFile)
                    .onChange((value: string) => {
                        this.currentFile = value;
                    });
                const p = new PopTextSuggest(this.app, text.inputEl, () => getFiles());
                p.onSelect((value) => {
                    text.setValue(value.source);
                    p.close();
                    this.currentFile = value.source;
                });
                currentFileInput = text;
            })
            .addButton((b) => {
                b.setButtonText("Add").onClick(async () => {
                    const file = this.currentFile;
                    if (!file) return;
                    if (!getFiles().includes(file)) return;
                    this.currentFiles = [...new Set([...this.currentFiles, file])];
                    this.currentFile = "";
                    fileList.set(this.currentFiles);
                    selectedTimestamp.update((selected) => {
                        if (selected[file] === undefined) selected[file] = LATEST;
                        return selected;
                    });
                    currentFileInput?.setValue("");
                });
            });

        const applyFiles = () => {
            fileList.set(this.currentFiles);
            selectedTimestamp.update((selected) => {
                Object.keys(selected).forEach((e) => {
                    if (!this.currentFiles.includes(e)) delete selected[e];
                });
                return selected;
            });
        };

        const expandFolder = (name: string, preventRender = false) => {
            const folderPrefix = name.slice(0, -1);
            const files = getFiles().filter((e) => e.startsWith(folderPrefix));
            this.currentFiles = [...new Set([...this.currentFiles, ...files])].filter((e) => e !== name);
            if (!preventRender) applyFiles();
        };

        new Setting(headerEl)
            .setName("")
            .addButton((b) => {
                b.setButtonText("Expand All Folder").onClick(async () => {
                    const folders = this.currentFiles.filter((e) => e.endsWith("*"));
                    for (const folder of folders) {
                        expandFolder(folder, true);
                    }
                    applyFiles();
                });
            })
            .addButton((b) => {
                b.setButtonText("Clear").onClick(async () => {
                    this.currentFiles = [];
                    applyFiles();
                });
            });

        new Setting(headerEl)
            .addButton((b) => {
                b.setButtonText("Select All Latest").onClick(async () => {
                    this.selectedTimestamps = {};
                    this.currentFiles.forEach((e) => {
                        this.selectedTimestamps[e] = LATEST;
                    });
                    selectedTimestamp.set(this.selectedTimestamps);
                });
            })
            .addButton((b) => {
                b.setButtonText("Clear").onClick(async () => {
                    this.selectedTimestamps = {};
                    selectedTimestamp.set(this.selectedTimestamps);
                });
            });

        const filesEl = containerEl.createDiv();
        filesEl.className = "diffzip-list";

        fileList.subscribe((value) => {
            this.currentFiles = value;
        });

        this.component = mount(RestoreFilesComponent, {
            target: filesEl,
            props: {
                plugin: this.plugin,
                toc,
                fileList,
                selectedTimestamp,
            },
        });

        const footerEl = containerEl.createDiv({ cls: "diffzip-dialog-footer" });
        let option = "";
        new Setting(footerEl).setName("Restore Options").addDropdown((d) => {
            d.addOptions({
                new: "Only new",
                all: "All",
                "all-delete": "All and delete extra",
            }).onChange((value) => {
                option = value;
            });
        });

        let prefix = "";
        new Setting(footerEl).setName("Additional prefix").addText((text) => {
            text.setPlaceholder("folder/")
                .setValue(prefix)
                .onChange((value: string) => {
                    prefix = value;
                });
        });

        new Setting(footerEl)
            .setName("")
            .addButton((b) => {
                b.setButtonText("Restore")
                    .onClick(async () => {
                        this.close();
                        const onlyNew = option === "new";
                        const skipDeleted = option !== "all-delete";
                        const selected = this.selectedTimestamps;
                        Object.keys(selected).forEach((e) => {
                            if (!this.currentFiles.includes(e)) delete selected[e];
                        });
                        const allFiles = Object.keys(toc);
                        const applyFiles = Object.fromEntries(
                            Object.entries(selected)
                                .map(([file, timestamp]) =>
                                    file.endsWith("*")
                                        ? allFiles
                                              .filter((e) => e.startsWith(file.slice(0, -1)))
                                              .map((file) => [file, timestamp] as const)
                                        : ([[file, timestamp]] as const)
                                )
                                .flat()
                        );
                        this.plugin.restoreVault(onlyNew, skipDeleted, applyFiles, prefix);
                    })
                    .setCta();
            })
            .addButton((b) => {
                b.setButtonText("Cancel").onClick(() => {
                    this.close();
                });
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

type TextSearchResult = { result: SearchResult; source: string };

class PopTextSuggest extends AbstractInputSuggest<TextSearchResult> {
    items: string[] = [];
    getItemFunc: () => string[];

    constructor(app: App, inputEl: HTMLInputElement, getItemFunc: () => string[]) {
        super(app, inputEl);
        this.getItemFunc = getItemFunc;
        this.items = this.getItemFunc();
    }

    open(): void {
        this.items = this.getItemFunc();
        super.open();
    }

    candidates: { result: SearchResult; source: string }[];

    protected getSuggestions(query: string): TextSearchResult[] | Promise<TextSearchResult[]> {
        const q = prepareFuzzySearch(query);
        const p = this.items.map((e) => ({ result: q(e), source: e })).filter((e) => e.result !== null) as {
            result: SearchResult;
            source: string;
        }[];
        const pSorted = p.sort((a, b) => {
            const diff = b.result.score - a.result.score;
            if (diff != 0) return diff;
            return a.source.localeCompare(b.source);
        });
        return pSorted;
    }

    renderSuggestion(value: TextSearchResult, el: HTMLElement): void {
        const source = [...value.source];
        const highlighted = source.map(() => false);
        const matches = value.result.matches.reverse();
        for (const [from, to] of matches) {
            for (let i = from; i < to; i++) {
                highlighted[i] = true;
            }
        }
        const div = el.createDiv();
        let prevSpan: HTMLElement | null = null;
        let prevHighlighted = false;
        for (let i = 0; i < source.length; i++) {
            if (prevHighlighted != highlighted[i] || prevSpan == null) {
                prevSpan = div.createSpan();
                prevHighlighted = highlighted[i];
                if (prevHighlighted) {
                    prevSpan.addClass("mod-highlight");
                    prevSpan.style.fontWeight = "bold";
                }
            }
            const t = source[i];
            prevSpan.appendText(t);
        }
    }
}
