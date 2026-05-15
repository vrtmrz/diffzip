import { Notice, Plugin, parseYaml, stringifyYaml } from "obsidian";
import * as fflate from "fflate";
import {
    getStorageForBackup,
    getStorageForVault,
    getStorageTypeForBackupAccess,
    getStorageTypeForVaultAccess,
    StorageAccessorTypes,
} from "./src/storage.ts";
import { type StorageAccessor } from "./src/StorageAccessor/StorageAccessor.ts";
import { RestoreDialog } from "./src/RestoreView.ts";
import { SyncRemoteDialog } from "./src/SyncRemoteDialog.ts";
import { confirmWithMessage, askSelectString } from "./src/dialog.ts";
import { Archiver, Extractor } from "./src/Archive.ts";
import { computeDigest, humanReadableSize, pieces, toArrayBuffer } from "./src/util.ts";
import {
    AutoBackupType,
    DEFAULT_SETTINGS,
    InfoFile,
    type DiffZipBackupSettings,
    type FileInfo,
    type FileInfos,
    type NoticeWithTimer,
} from "./src/types.ts";
import { applySendBatchToToc, planSendBatches, type TocUpdate } from "./src/SyncPlanner.ts";
import { DiffZipSettingTab } from "./src/DiffZipSettingTab.ts";
import { ProgressFragment } from "./src/ProgressFragment.ts";
import { CombinedFragment } from "./src/CombinedFragment.ts";
import { SyncProgressDialog } from "./src/SyncProgressDialog.ts";

export default class DiffZipBackupPlugin extends Plugin {
    settings!: DiffZipBackupSettings;

    get isMobile(): boolean {
        // @ts-ignore
        return !!this.app.isMobile;
    }
    get isDesktopMode(): boolean {
        return this.settings.desktopFolderEnabled && !this.isMobile;
    }

    get backupFolder(): string {
        if (this.settings.bucketEnabled) return this.settings.backupFolderBucket;
        return this.isDesktopMode ? this.settings.BackupFolderDesktop : this.settings.backupFolderMobile;
    }

    _backups!: StorageAccessor;
    get backups(): StorageAccessor {
        const type = getStorageTypeForBackupAccess(this);
        if (!this._backups || this._backups.type != type) {
            this._backups = getStorageForBackup(this);
        }
        return this._backups;
    }
    _vaultAccess!: StorageAccessor;
    get vaultAccess(): StorageAccessor {
        const type = getStorageTypeForVaultAccess(this);
        if (!this._vaultAccess || this._vaultAccess.type != type) {
            this._vaultAccess = getStorageForVault(this);
        }
        return this._vaultAccess;
    }

    get sep(): string {
        //@ts-ignore
        return (this.isDesktopMode ? this.app.vault.adapter.path.sep : "/") as string;
    }

    messages = {} as Record<string, NoticeWithTimer>;

    logMessage(message: string, key?: string) {
        this.logWrite(message, key);
        if (!key) {
            new Notice(message, 3000);
            return;
        }
        let n: NoticeWithTimer | undefined = undefined;
        if (key in this.messages) {
            n = this.messages[key];
            clearTimeout(n.timer);
            if (!n.notice.noticeEl.isShown()) {
                delete this.messages[key];
            } else {
                n.notice.setMessage(message);
            }
        }
        if (!n || !(key in this.messages)) {
            n = {
                notice: new Notice(message, 0),
            };
        }
        n.timer = setTimeout(() => {
            n?.notice?.hide();
        }, 5000);
        this.messages[key] = n;
    }

    hideMessage(key: string) {
        const n = this.messages[key];
        if (n) {
            clearTimeout(n.timer);
            n.notice.hide();
            delete this.messages[key];
        }
    }
    logWrite(message: string, key?: string) {
        const dt = new Date().toLocaleString();
        console.log(`${dt}\t${message}`);
    }

    async getFiles(path: string, ignoreList: string[], progress: ProgressFragment) {
        const pathPart = ellipsisMiddle(path);
        progress.note = `Scanning ${pathPart}`;
        const w = await this.app.vault.adapter.list(path);
        progress.total += w.folders.length;
        let files = [...w.files.filter((e) => !ignoreList.some((ee) => e.endsWith(ee)))];
        L1: for (const v of w.folders) {
            for (const ignore of ignoreList) {
                if (v.endsWith(ignore)) {
                    progress.value++;
                    continue L1;
                }
            }
            // files = files.concat([v]);
            files = files.concat(await this.getFiles(v, ignoreList, progress));
            progress.value++;
        }
        return files;
    }

    async loadTOC() {
        let toc = {} as FileInfos;
        const tocFilePath = this.backups.normalizePath(`${this.backupFolder}${this.sep}${InfoFile}`);
        const tocExist = await this.backups.isFileExists(tocFilePath);
        if (tocExist) {
            this.logWrite(`Loading Backup information`, "proc-index");
            try {
                const tocBin = await this.backups.readTOC(tocFilePath);
                if (tocBin == null || tocBin === false) {
                    this.logMessage(`LOAD ERROR: Could not read Backup information`, "proc-index");
                    return {};
                }
                const tocStr = new TextDecoder().decode(tocBin);
                toc = parseYaml(tocStr.replace(/^```$/gm, "")) as FileInfos;
                if (toc == null) {
                    this.logMessage(`PARSE ERROR: Could not parse Backup information`, "proc-index");
                    toc = {};
                } else {
                    this.logWrite(`Backup information has been loaded`, "proc-index");
                }
            } catch (ex) {
                this.logMessage(`Something went wrong while parsing Backup information`, "proc-index");
                console.warn(ex);
                toc = {};
            }
        } else {
            this.logMessage(`Backup information looks missing`, "proc-index");
        }
        return toc;
    }

    async getAllFiles() {
        const ignores = [
            "node_modules",
            ".git",
            this.app.vault.configDir + "/trash",
            this.app.vault.configDir + "/workspace.json",
            this.app.vault.configDir + "/workspace-mobile.json",
        ];
        if (this.settings.includeHiddenFolder) {
            const progress = new ProgressFragment({
                title: "Gathering Files",
                value: 0,
                total: 0,
                onComplete: () => {
                    window.setTimeout(() => {
                        notice.hide();
                    }, 1000);
                },
            });
            const noticeFragment = activeDocument.createDocumentFragment();
            const noticeContainer = activeDocument.createElement("div");
            noticeContainer.classList.add("diffzip-progress-notice");
            noticeContainer.appendChild(progress.fragment);
            noticeFragment.appendChild(noticeContainer);
            const notice = new Notice(noticeFragment, 0);
            return (await this.getFiles("", ignores, progress)).filter((e) => !e.startsWith(".trash/"));
        }
        return this.app.vault.getFiles().map((e) => e.path);
    }

    async createZip(verbosity: boolean, onlyNew = false, skipDeleted: boolean = false) {
        const key = "proc-zip-process-" + Date.now();
        const log = verbosity
            ? (msg: string, key?: string) => this.logWrite(msg, key)
            : (msg: string, key?: string) => this.logMessage(msg, key);
        const allFiles = await this.getAllFiles();
        const toc = await this.loadTOC();
        const today = new Date();
        const secondsInDay = ~~(today.getTime() / 1000 - today.getTimezoneOffset() * 60) % 86400;
        const baseFileName = `${today.getFullYear()}-${today.getMonth() + 1}-${today.getDate()}-${secondsInDay}.zip`;
        const makeZipName = (batchIndex: number) =>
            batchIndex === 0 ? baseFileName : baseFileName.replace(/\.zip$/, `-${batchIndex + 1}.zip`);

        let progressDialog: SyncProgressDialog | undefined;
        let cancelRequested = false;
        const cancelledError = new Error("Sync cancelled");
        const fragmentOption = {
            total: 0,
            onComplete: () => onCloseProgress(),
            onProgress: () => {},
        } as const;

        const missingFileProgress = new ProgressFragment({
            title: "Checking file and TOC",
            ...fragmentOption,
        });
        const checkingProgress = new ProgressFragment({
            title: "Check and Archiving Files",
            ...fragmentOption,
        });
        const fileProcessingProgress = new ProgressFragment({
            title: "File Processing",
            formatNumeric: (value, total) => `${humanReadableSize(value)} / ${humanReadableSize(total)}`,
            ...fragmentOption,
        });
        const fileArchivedProgress = new ProgressFragment({
            title: "Archiving Files",
            ...fragmentOption,
        });
        const uploadingProgress = new ProgressFragment({
            title: "Committing ZIP Files",
            formatNumeric: (value, total) => `${humanReadableSize(value)} / ${humanReadableSize(total)}`,
            ...fragmentOption,
        });
        const combinedFragment = new CombinedFragment([
            () => missingFileProgress.reconstructFragment(),
            () => checkingProgress.reconstructFragment(),
            () => fileProcessingProgress.reconstructFragment(),
            () => fileArchivedProgress.reconstructFragment(),
            () => uploadingProgress.reconstructFragment(),
        ]);
        const buildProgressContent = () => combinedFragment.rebuildFragment();

        progressDialog = new SyncProgressDialog(this.app, {
            title: "Creating Differential Backup",
            content: buildProgressContent(),
            onCancel: () => {
                if (cancelRequested) return;
                cancelRequested = true;
                uploadingProgress.note = "Cancelling...";
            },
        });
        progressDialog.open();

        const throwIfCancelled = () => {
            if (cancelRequested) {
                throw cancelledError;
            }
        };

        const onCloseProgress = () => {
            if (progressDialog == undefined) return;
            if (
                [
                    missingFileProgress,
                    checkingProgress,
                    fileProcessingProgress,
                    fileArchivedProgress,
                    uploadingProgress,
                ].every((e) => e.isCompleted || e.isCancelled)
            ) {
                progressDialog.finish("Backup completed.");
            }
        };

        const finishCancelled = () => {
            missingFileProgress.isCancelled = true;
            checkingProgress.isCancelled = true;
            fileProcessingProgress.isCancelled = true;
            fileArchivedProgress.isCancelled = true;
            uploadingProgress.note = "Cancelled.";
            uploadingProgress.isCancelled = true;
            progressDialog?.finish("Backup cancelled.");
            this.logMessage("Backup cancelled.", key);
        };

        try {
            // ── Phase 1: detect missing files ────────────────────────────────
            const missingUpdates: TocUpdate[] = [];
            missingFileProgress.total = Object.keys(toc).length;
            for (const [filename, fileInfo] of Object.entries(toc)) {
                throwIfCancelled();
                try {
                    if (fileInfo.missing) continue;
                    if (!(await this.vaultAccess.isFileExists(this.vaultAccess.normalizePath(filename)))) {
                        if (skipDeleted) continue;
                        log(`File ${filename} is missing`);
                        missingUpdates.push({ kind: "missing", filename, modifiedTime: today.getTime() });
                    }
                } finally {
                    missingFileProgress.value++;
                }
            }

            // ── Phase 2: scan vault for changed files ─────────────────────────
            type PrepFile = { filename: string; content: Uint8Array; digest: string; mtime: number; size: number };
            const changedFiles: PrepFile[] = [];
            const normalFiles = allFiles.filter(
                (e) =>
                    !e.startsWith(this.backupFolder + this.sep) && !e.startsWith(this.settings.restoreFolder + this.sep)
            );
            checkingProgress.total = normalFiles.length;
            let processed = 0;
            for (const path of normalFiles) {
                throwIfCancelled();
                try {
                    processed++;
                    checkingProgress.note = `Processing ${ellipsisMiddle(path)}`;
                    const stat = await this.vaultAccess.stat(path);
                    throwIfCancelled();
                    if (!stat) {
                        this.logMessage(`Archiving: Could not read stat ${path}`);
                        continue;
                    }
                    if (onlyNew && path in toc && stat.mtime <= toc[path].mtime) {
                        this.logWrite(`${path} older than the last backup, skipping`);
                        continue;
                    }
                    const content = await this.vaultAccess.readBinary(path);
                    if (!content) {
                        this.logMessage(`Archiving: Could not read ${path}`);
                        continue;
                    }
                    const f = new Uint8Array(content);
                    const digest = await computeDigest(f);
                    if (path in toc && toc[path].digest === digest) {
                        this.logWrite(`${path} Not changed`);
                        continue;
                    }
                    changedFiles.push({ filename: path, content: f, digest, mtime: stat.mtime, size: f.byteLength });
                } finally {
                    checkingProgress.value++;
                }
            }

            if (changedFiles.length === 0 && missingUpdates.length === 0) {
                fileProcessingProgress.isCancelled = true;
                checkingProgress.isCancelled = true;
                fileArchivedProgress.isCancelled = true;
                uploadingProgress.note = `No files have been changed. \nSkipping ZIP generation...`;
                uploadingProgress.isCancelled = true;
                progressDialog?.finish("No files have been changed.");
                return;
            }

            // ── Phase 3: plan batches ────────────────────────────────────────
            const maxTotalSizeInZip =
                this.settings.maxTotalSizeInZip > 0 ? this.settings.maxTotalSizeInZip * 1024 * 1024 : 0;
            const { batches, oversizedFiles } = planSendBatches(
                changedFiles.map((f) => ({ filename: f.filename, size: f.size })),
                this.settings.maxFilesInZip,
                maxTotalSizeInZip
            );
            if (oversizedFiles.length > 0) {
                const oversizedList = oversizedFiles
                    .map((filename) => {
                        const file = changedFiles.find((entry) => entry.filename === filename);
                        return file ? `${filename} (${humanReadableSize(file.size)})` : filename;
                    })
                    .join(", ");
                log(`⚠️ Oversized files placed in solo ZIPs: ${oversizedList}`);
            }
            const fileByPath = new Map(changedFiles.map((f) => [f.filename, f]));
            const effectiveBatches = batches.length > 0 ? batches : [{ files: [], totalSize: 0 }];

            // ── Phase 4: write batches ───────────────────────────────────────
            let currentToc = toc;
            let totalZipped = 0;
            try {
                fileArchivedProgress.total = changedFiles.length;
                fileArchivedProgress.value = 0;
                for (let batchIndex = 0; batchIndex < effectiveBatches.length; batchIndex++) {
                    throwIfCancelled();
                    const batch = effectiveBatches[batchIndex];
                    const zipName = makeZipName(batchIndex);
                    const processedAt = today.getTime();

                    const updates: TocUpdate[] = [];
                    if (batchIndex === 0) updates.push(...missingUpdates);

                    const zippedFiles: { filename: string; content: Uint8Array; mtime: number }[] = [];
                    for (const planned of batch.files) {
                        const f = fileByPath.get(planned.filename)!;
                        updates.push({ kind: "file", filename: f.filename, digest: f.digest, mtime: f.mtime });
                        zippedFiles.push({ filename: f.filename, content: f.content, mtime: f.mtime });
                    }

                    const nextToc = applySendBatchToToc(currentToc, updates, zipName, processedAt);

                    // Build ZIP with per-file Archiver progress
                    const zip = new Archiver();
                    fileProcessingProgress.isCancelled = false;
                    for (const file of zippedFiles) {
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
                    uploadingProgress.total = buf.byteLength;
                    uploadingProgress.value = 0;

                    const step =
                        this.settings.maxSize / 1 == 0 ? buf.byteLength + 1 : (this.settings.maxSize / 1) * 1024 * 1024;
                    let pieceCount = buf.byteLength > step ? 1 : 0;
                    for (const chunk of pieces(buf, step)) {
                        throwIfCancelled();
                        const outZipFile = this.backups.normalizePath(
                            `${this.backupFolder}${this.sep}${zipName}${pieceCount === 0 ? "" : "." + `00${pieceCount}`.slice(-3)}`
                        );
                        pieceCount++;
                        uploadingProgress.note = `Committing ${ellipsisMiddle(outZipFile)}`;
                        if (!(await this.backups.writeBinary(outZipFile, toArrayBuffer(chunk)))) {
                            throw new Error(`Creating ${outZipFile} has been failed!`);
                        }
                        uploadingProgress.value += chunk.byteLength;
                    }

                    const tocFilePath = this.backups.normalizePath(`${this.backupFolder}${this.sep}${InfoFile}`);
                    throwIfCancelled();
                    if (
                        !(await this.backups.writeTOC(
                            tocFilePath,
                            toArrayBuffer(new TextEncoder().encode(`\`\`\`\n${stringifyYaml(nextToc)}\n\`\`\`\n`))
                        ))
                    ) {
                        throw new Error(`Updating TOC has been failed!`);
                    }
                    log(
                        `Backup batch ${batchIndex + 1}/${effectiveBatches.length} written (${batch.files.length} files)`,
                        key
                    );
                    currentToc = nextToc;
                    totalZipped += batch.files.length;
                }
                this.logMessage(
                    `${processed} of ${normalFiles.length} files checked, ${totalZipped} zipped in ${effectiveBatches.length} batch(es).`,
                    key
                );
            } catch (e) {
                if (e === cancelledError) {
                    finishCancelled();
                    return;
                }
                this.logMessage(`Something went wrong while processing ${processed} files, ${totalZipped} zipped`, key);
                this.logWrite(e instanceof Error ? e.message : String(e), key);
            }
        } catch (e) {
            if (e === cancelledError) {
                finishCancelled();
                return;
            }
            this.logMessage("Something went wrong before archiving started", key);
            this.logWrite(e instanceof Error ? e.message : String(e), key);
        }
    }

    async extract(zipFile: string, extractFiles: string[]): Promise<void>;
    async extract(zipFile: string, extractFiles: string, restoreAs: string): Promise<void>;
    async extract(zipFile: string, extractFiles: string[], restoreAs: undefined, restorePrefix: string): Promise<void>;
    async extract(
        zipFile: string,
        extractFiles: string | string[],
        restoreAs: string | undefined = undefined,
        restorePrefix: string = ""
    ): Promise<void> {
        const hasMultipleSupplied = Array.isArray(extractFiles);
        const zipPath = this.backups.normalizePath(`${this.backupFolder}${this.sep}${zipFile}`);
        const zipF = await this.backups.isExists(zipPath);
        let files = [] as string[];
        if (zipF) {
            files = [zipPath];
        } else {
            let hasNext = true;
            let counter = 0;
            do {
                counter++;
                const partialZipPath = zipPath + "." + `00${counter}`.slice(-3);
                if (await this.backups.isExists(partialZipPath)) {
                    files.push(partialZipPath);
                } else {
                    hasNext = false;
                }
            } while (hasNext);
        }
        if (files.length == 0) {
            this.logMessage("Archived ZIP files were not found!");
        }
        const restored = [] as string[];

        const extractor = new Extractor(
            (file: fflate.UnzipFile) => {
                if (hasMultipleSupplied) {
                    return extractFiles.indexOf(file.name) !== -1;
                }
                return file.name === extractFiles;
            },
            async (file: string, dat: Uint8Array<ArrayBuffer>) => {
                const fileName = restoreAs ?? file;
                const restoreTo = hasMultipleSupplied ? `${restorePrefix}${fileName}` : fileName;
                if (await this.vaultAccess.writeBinary(restoreTo, toArrayBuffer(dat))) {
                    restored.push(restoreTo);
                    const files = restored.slice(-5).join("\n");
                    this.logMessage(`${restored.length} files have been restored! \n${files}\n...`, "proc-zip-extract");
                } else {
                    this.logMessage(`Creating or Overwriting ${file} has been failed!`);
                }
            }
        );

        const size = 1024 * 1024;
        for (const file of files) {
            this.logMessage(`Processing ${file}...`, "proc-zip-export-processing");
            const binary = await this.backups.readBinary(file);
            if (binary == null || binary === false) {
                this.logMessage(`Could not read ${file}`);
                return;
            }
            const chunks = pieces(new Uint8Array(binary), size);
            for (const chunk of chunks) {
                extractor.addZippedContent(chunk);
            }
        }
    }

    async selectAndRestore() {
        const files = await this.loadTOC();
        const filenames = Object.entries(files)
            .sort((a, b) => b[1].mtime - a[1].mtime)
            .map((e) => e[0]);
        if (filenames.length == 0) {
            return;
        }
        const selected = await askSelectString(this.app, "Select file", filenames);
        if (!selected) {
            return;
        }
        const revisions = files[selected].history;
        const d = `\u{2063}`;
        const revisionList = revisions.map((e) => `${e.zipName}${d} (${e.modified})`).reverse();
        const selectedTimestamp = await askSelectString(this.app, "Select file", revisionList);
        if (!selectedTimestamp) {
            return;
        }
        const [filename] = selectedTimestamp.split(d);
        const suffix = filename.replace(".zip", "");
        // No cares about without extension
        const extArr = selected.split(".");
        const ext = extArr.pop();
        const selectedWithoutExt = extArr.join(".");
        const RESTORE_OVERWRITE = "Original place and okay to overwrite";
        const RESTORE_TO_RESTORE_FOLDER = "Under the restore folder";
        const RESTORE_WITH_SUFFIX = "Original place but with ZIP name suffix";
        const restoreMethods = [RESTORE_TO_RESTORE_FOLDER, RESTORE_OVERWRITE, RESTORE_WITH_SUFFIX];
        const howToRestore = await askSelectString(this.app, "Where to restore?", restoreMethods);
        const restoreAs =
            howToRestore == RESTORE_OVERWRITE
                ? selected
                : howToRestore == RESTORE_TO_RESTORE_FOLDER
                  ? this.vaultAccess.normalizePath(`${this.settings.restoreFolder}${this.sep}${selected}`)
                  : howToRestore == RESTORE_WITH_SUFFIX
                    ? `${selectedWithoutExt}-${suffix}.${ext}`
                    : "";
        if (!restoreAs) {
            return;
        }
        await this.extract(filename, selected, restoreAs);
    }

    async pickRevisions(files: FileInfos, prefix = ""): Promise<string> {
        const BACK = "[..]";
        const timestamps = new Set<string>();
        const all = Object.entries(files).filter((e) => e[0].startsWith(prefix));
        for (const f of all) {
            f[1].history.map((e) => e.modified).map((e) => timestamps.add(e));
        }
        const modifiedList = [...timestamps].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).reverse();
        modifiedList.unshift(BACK);
        const selected = await askSelectString(this.app, "Until?", modifiedList);
        if (!selected) {
            return "";
        }
        return selected;
    }
    async selectAndRestoreFolder(filesSrc?: FileInfos, prefix = "") {
        if (!filesSrc) filesSrc = await this.loadTOC();
        const files = JSON.parse(JSON.stringify({ ...filesSrc })) as typeof filesSrc;
        const level = prefix.split("/").filter((e) => !!e).length + 1;
        const filenamesAll = Object.entries(files)
            .sort((a, b) => b[1].mtime - a[1].mtime)
            .map((e) => e[0]);
        const filenamesFiltered = filenamesAll.filter((e) => e.startsWith(prefix));
        const filenamesA = filenamesFiltered
            .map((e) => {
                const paths = e.split("/");
                const name = paths.splice(0, level).join("/");
                if (paths.length == 0 && name) return name;
                return `${name}/`;
            })
            .sort((a, b) => {
                const isDirA = a.endsWith("/");
                const isDirB = b.endsWith("/");
                if (isDirA && !isDirB) return -1;
                if (!isDirA && isDirB) return 1;
                if (isDirA && isDirB) return a.localeCompare(b);
                return 0;
            });

        const filenames = [...new Set(filenamesA)];
        if (filenames.length == 0) {
            return;
        }

        const BACK = "[..]";
        const ALL = "[ALL]";

        filenames.unshift(ALL);
        filenames.unshift(BACK);

        const selected = await askSelectString(this.app, "Select file", filenames);
        if (!selected) {
            return;
        }
        if (selected == BACK) {
            const p = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
            const parent = p.split("/").slice(0, -1).join("/");
            await this.selectAndRestoreFolder(filesSrc, parent);
            return;
        }
        if (selected == ALL) {
            // Collect all files and timings
            const selectedThreshold = await this.pickRevisions(files, prefix);
            if (!selectedThreshold) {
                return;
            }
            if (selectedThreshold == BACK) {
                await this.selectAndRestoreFolder(filesSrc, prefix);
                return;
            }
            const allFiles = Object.entries(files).filter((e) => e[0].startsWith(prefix));
            const maxDate = new Date(selectedThreshold).getTime();
            const fileMap = new Map<string, FileInfo["history"][0]>();
            for (const [key, files] of allFiles) {
                for (const fileInfo of files.history) {
                    //keep only the latest one
                    const fileModified = new Date(fileInfo.modified).getTime();
                    if (fileModified > maxDate) continue;
                    const info = fileMap.get(key);
                    if (!info) {
                        fileMap.set(key, fileInfo);
                    } else {
                        if (new Date(info.modified).getTime() < fileModified) {
                            fileMap.set(key, fileInfo);
                        }
                    }
                }
            }
            const zipMap = new Map<string, string[]>();
            for (const [filename, fileInfo] of fileMap) {
                const path = fileInfo.zipName;
                const arr = zipMap.get(path) ?? [];
                arr.push(filename);
                zipMap.set(path, arr);
            }
            // const fileMap = new Map<string, string>();
            // for (const [zipName, fileInfo] of zipMap) {
            // 	const path = fileInfo.zipName;
            // 	fileMap.set(path, zipName);
            // }
            const zipList = [...zipMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
            const filesCount = zipList.reduce((a, b) => a + b[1].length, 0);
            if (
                (await askSelectString(
                    this.app,
                    `Are you sure to restore(Overwrite) ${filesCount} files from ${zipList.length} ZIPs`,
                    ["Y", "N"]
                )) != "Y"
            ) {
                this.logMessage(`Cancelled`);
                return;
            }
            this.logMessage(`Extract ${zipList.length} ZIPs`);
            let i = 0;
            for (const [zipName, files] of zipList) {
                i++;
                this.logMessage(`Extract ${files.length} files from ${zipName} (${i}/${zipList.length})`);
                await this.extract(zipName, files);
            }
            // console.dir(zipMap);

            return;
        }
        if (selected.endsWith("/")) {
            await this.selectAndRestoreFolder(filesSrc, selected);
            return;
        }
        const revisions = files[selected].history;
        const d = `\u{2063}`;
        const revisionList = revisions.map((e) => `${e.zipName}${d} (${e.modified})`).reverse();
        revisionList.unshift(BACK);
        const selectedTimestamp = await askSelectString(this.app, "Select file", revisionList);
        if (!selectedTimestamp) {
            return;
        }
        if (selectedTimestamp == BACK) {
            await this.selectAndRestoreFolder(filesSrc, prefix);
            return;
        }
        const [filename] = selectedTimestamp.split(d);
        const suffix = filename.replace(".zip", "");
        // No cares about without extension
        const extArr = selected.split(".");
        const ext = extArr.pop();
        const selectedWithoutExt = extArr.join(".");
        const RESTORE_OVERWRITE = "Original place and okay to overwrite";
        const RESTORE_TO_RESTORE_FOLDER = "Under the restore folder";
        const RESTORE_WITH_SUFFIX = "Original place but with ZIP name suffix";
        const restoreMethods = [RESTORE_TO_RESTORE_FOLDER, RESTORE_OVERWRITE, RESTORE_WITH_SUFFIX];
        const howToRestore = await askSelectString(this.app, "Where to restore?", restoreMethods);
        const restoreAs =
            howToRestore == RESTORE_OVERWRITE
                ? selected
                : howToRestore == RESTORE_TO_RESTORE_FOLDER
                  ? this.vaultAccess.normalizePath(`${this.settings.restoreFolder}${this.sep}${selected}`)
                  : howToRestore == RESTORE_WITH_SUFFIX
                    ? `${selectedWithoutExt}-${suffix}.${ext}`
                    : "";
        if (!restoreAs) {
            return;
        }
        await this.extract(filename, selected, restoreAs);
    }
    // _debugDialogue?: RestoreDialog;
    async onLayoutReady() {
        // if (this._debugDialogue) {
        // 	this._debugDialogue.close();
        // 	this._debugDialogue = undefined;
        // }
        if (this.settings.startBackupAtLaunch) {
            const onlyNew =
                this.settings.startBackupAtLaunchType == AutoBackupType.ONLY_NEW ||
                this.settings.startBackupAtLaunchType == AutoBackupType.ONLY_NEW_AND_EXISTING;
            const skipDeleted = this.settings.startBackupAtLaunchType == AutoBackupType.ONLY_NEW_AND_EXISTING;
            // Fire and forget, no need to await
            void this.createZip(false, onlyNew, skipDeleted);
        }
    }
    // onunload(): void {
    // 	this._debugDialogue?.close();
    // }

    async restoreVault(
        onlyNew = true,
        deleteMissing: boolean = false,
        fileFilter: Record<string, number> | undefined = undefined,
        prefix: string = ""
    ) {
        this.logMessage(`Checking backup information...`);
        const files = await this.loadTOC();
        // const latestZipMap = new Map<string, string>();
        const zipFileMap = new Map<string, string[]>();
        const thisPluginDir = this.manifest.dir;
        const deletingFiles = [] as string[];
        let processFileCount = 0;
        for (const [filename, fileInfo] of Object.entries(files)) {
            if (fileFilter) {
                const matched = Object.keys(fileFilter)
                    .filter((e) => (e.endsWith("*") ? filename.startsWith(e.slice(0, -1)) : e == filename))
                    .sort((a, b) => b.length - a.length);
                if (matched.length == 0) {
                    this.logWrite(`${filename}: is not matched with supplied filter. Skipping...`);
                    continue;
                }
                const matchedFilter = matched[0];
                // remove history after the filter
                fileInfo.history = fileInfo.history.filter(
                    (e) => new Date(e.modified).getTime() <= fileFilter[matchedFilter]
                );
            }
            if (thisPluginDir && fileInfo.filename.startsWith(thisPluginDir)) {
                this.logWrite(`${filename} is a plugin file. Skipping on vault restoration`);
                continue;
            }
            const history = fileInfo.history;
            if (history.length == 0) {
                this.logWrite(`${filename}: has no history. Skipping...`);
                continue;
            }
            history.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());
            const latest = history[0];
            const zipName = latest.zipName;
            const localFileName = this.vaultAccess.normalizePath(`${prefix}${filename}`);
            const localStat = await this.vaultAccess.stat(localFileName);
            if (localStat) {
                const content = await this.vaultAccess.readBinary(localFileName);
                if (!content) {
                    this.logWrite(`${filename}: has been failed to read`);
                    continue;
                }
                const localDigest = await computeDigest(new Uint8Array(content));
                if (localDigest == latest?.digest) {
                    this.logWrite(`${filename}: is as same as the backup. Skipping...`);
                    continue;
                }
                if (fileInfo.missing) {
                    if (!deleteMissing) {
                        this.logWrite(`${filename}: is marked as missing, but existing in the vault. Skipping...`);
                        continue;
                    } else {
                        // this.logWrite(`${filename}: is marked as missing. Deleting...`);
                        deletingFiles.push(filename);
                        //TODO: Delete the file
                    }
                }
                const localMtime = localStat.mtime;
                const remoteMtime = new Date(latest.modified).getTime();
                if (onlyNew && localMtime >= remoteMtime) {
                    this.logWrite(`${filename}: Ours is newer than the backup. Skipping...`);
                    continue;
                }
            } else {
                if (fileInfo.missing) {
                    this.logWrite(`${filename}: is missing and not found in the vault. Skipping...`);
                    continue;
                }
            }
            this.logWrite(`${filename}: will be restored from ${zipName}`);
            if (!zipFileMap.has(zipName)) {
                zipFileMap.set(zipName, []);
            }
            zipFileMap.get(zipName)?.push(filename);
            processFileCount++;

            // latestZipMap.set(filename, zipName);
        }
        if (processFileCount == 0 && deletingFiles.length == 0) {
            this.logMessage(`Nothing to restore`);
            return;
        }
        const detailFiles = `<details>

${[...zipFileMap.entries()]
    .map((e) => `${e[1].map((ee) => `- ${ee}  (${e[0]})`).join("\n")}\n`)
    .sort((a, b) => a.localeCompare(b))
    .join("")}


</details>`;
        const detailDeletedFiles = `<details>

${deletingFiles.map((e) => `- ${e}`).join("\n")}

</details>`;
        const deleteMessage =
            deleteMissing && deletingFiles.length > 0
                ? `And ${deletingFiles.length} files will be deleted.\n${detailDeletedFiles}\n`
                : "";
        const message = `We have ${processFileCount} files to restore on ${zipFileMap.size} ZIPs. \n${detailFiles}\n${deleteMessage}Are you sure to proceed?`;
        const RESTORE_BUTTON = "Yes, restore them!";
        const CANCEL = "Cancel";
        if (
            (await confirmWithMessage(this, "Restore Confirmation", message, [RESTORE_BUTTON, CANCEL], CANCEL)) !=
            RESTORE_BUTTON
        ) {
            this.logMessage(`Cancelled`);
            return;
        }
        for (const [zipName, files] of zipFileMap) {
            this.logMessage(`Extracting ${zipName}...`);
            await this.extract(zipName, files, undefined, prefix);
        }
        // console.dir(zipFileMap);
    }
    async onload() {
        await this.loadSettings();
        if ("backupFolder" in this.settings) {
            this.settings.backupFolderMobile = this.settings.backupFolder as string;
            delete this.settings.backupFolder;
        }
        this.app.workspace.onLayoutReady(() => this.onLayoutReady());

        this.addCommand({
            id: "a-find-from-backups",
            name: "Restore from backups",
            callback: async () => {
                const d = new RestoreDialog(this.app, this);
                d.open();
            },
        });
        this.addCommand({
            id: "find-from-backups-old",
            name: "Restore from backups (previous behaviour)",
            callback: async () => {
                await this.selectAndRestore();
            },
        });

        this.addCommand({
            id: "find-from-backups-dir",
            name: "Restore from backups per folder",
            callback: async () => {
                await this.selectAndRestoreFolder();
            },
        });
        this.addCommand({
            id: "b-create-diff-zip",
            name: "Create Differential Backup",
            callback: async () => {
                await this.createZip(true);
            },
        });
        this.addCommand({
            id: "b-create-diff-zip-only-new",
            name: "Create Differential Backup Only Newer Files",
            callback: async () => {
                await this.createZip(true, true);
            },
        });
        this.addCommand({
            id: "b-create-diff-zip-only-new-and-existing",
            name: "Create Non-Destructive Differential Backup",
            callback: async () => {
                await this.createZip(true, false, true);
            },
        });
        this.addCommand({
            id: "b-create-diff-zip-only-new-and-existing-only-new",
            name: "Create Non-Destructive Differential Backup Only Newer Files",
            callback: async () => {
                await this.createZip(true, true, true);
            },
        });

        this.addCommand({
            id: "vault-restore-from-backups-only-new",
            name: "Fetch all new files from the backups",
            callback: async () => {
                await this.restoreVault(true, false);
            },
        });
        this.addCommand({
            id: "vault-restore-from-backups-with-deletion",
            name: "⚠ Restore Vault from backups and delete with deletion",
            callback: async () => {
                await this.restoreVault(false, true);
            },
        });
        this.addCommand({
            id: "check-and-mirror-remote",
            name: "Selective Sync Remote Backup",
            callback: () => {
                const storageType = getStorageTypeForBackupAccess(this);
                if (storageType !== StorageAccessorTypes.S3 && storageType !== StorageAccessorTypes.EXTERNAL) {
                    new Notice(
                        "Remote storage is not configured. Please enable S3 or Desktop external folder in settings."
                    );
                    return;
                }
                const d = new SyncRemoteDialog(this.app, this);
                d.open();
            },
        });
        this.addSettingTab(new DiffZipSettingTab(this.app, this));
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()) as DiffZipBackupSettings;
    }

    async resetToC() {
        const toc = {} as FileInfos;
        const tocFilePath = this.backups.normalizePath(`${this.backupFolder}${this.sep}${InfoFile}`);
        // Update TOC
        if (
            await this.backups.writeTOC(
                tocFilePath,
                toArrayBuffer(new TextEncoder().encode(`\`\`\`\n${stringifyYaml(toc)}\n\`\`\`\n`))
            )
        ) {
            this.logMessage(`Backup information has been reset`);
        } else {
            this.logMessage(`Backup information cannot reset`);
        }
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}

function ellipsisMiddle(text: string, maxLength: number = 60) {
    if (text.length <= maxLength) {
        return text;
    }
    const ellipsis = "...";
    const charsToShow = maxLength - ellipsis.length;
    const start = Math.ceil(charsToShow / 2);
    const end = text.length - Math.floor(charsToShow / 2);
    return text.slice(0, start) + ellipsis + text.slice(end);
}
