import { Notice, Plugin, parseYaml, stringifyYaml } from "obsidian";
import * as fflate from "fflate";
import { getStorage, getStorageInstance, getStorageType, type StorageAccessor } from "./storage";
import { RestoreDialog } from "./RestoreView";
import { confirmWithMessage } from "./dialog";
import { Archiver, Extractor } from "./Archive";
import { computeDigest, pieces } from "./util";
import {
    AutoBackupType,
    DEFAULT_SETTINGS,
    InfoFile,
    type DiffZipBackupSettings,
    type FileInfo,
    type FileInfos,
    type NoticeWithTimer,
} from "./types";
import { DiffZipSettingTab } from "./DiffZipSettingTab";
import { askSelectString } from "dialog";

export default class DiffZipBackupPlugin extends Plugin {
    settings: DiffZipBackupSettings;

    get isMobile(): boolean {
        // @ts-ignore
        return this.app.isMobile;
    }
    get isDesktopMode(): boolean {
        return this.settings.desktopFolderEnabled && !this.isMobile;
    }

    get backupFolder(): string {
        if (this.settings.bucketEnabled) return this.settings.backupFolderBucket;
        return this.isDesktopMode ? this.settings.BackupFolderDesktop : this.settings.backupFolderMobile;
    }

    _backups: StorageAccessor;
    get backups(): StorageAccessor {
        const type = getStorageType(this);
        if (!this._backups || this._backups.type != type) {
            this._backups = getStorage(this);
        }
        return this._backups;
    }
    _vaultAccess: StorageAccessor;
    get vaultAccess(): StorageAccessor {
        const type = this.settings.includeHiddenFolder ? "direct" : "normal";
        if (!this._vaultAccess || this._vaultAccess.type != type) {
            this._vaultAccess = getStorageInstance(type, this, undefined, true);
        }
        return this._vaultAccess;
    }

    get sep(): string {
        //@ts-ignore
        return this.isDesktopMode ? this.app.vault.adapter.path.sep : "/";
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
    logWrite(message: string, key?: string) {
        const dt = new Date().toLocaleString();
        console.log(`${dt}\t${message}`);
    }

    async getFiles(path: string, ignoreList: string[]) {
        const w = await this.app.vault.adapter.list(path);
        let files = [...w.files.filter((e) => !ignoreList.some((ee) => e.endsWith(ee)))];
        L1: for (const v of w.folders) {
            for (const ignore of ignoreList) {
                if (v.endsWith(ignore)) {
                    continue L1;
                }
            }
            // files = files.concat([v]);
            files = files.concat(await this.getFiles(v, ignoreList));
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
                toc = parseYaml(tocStr.replace(/^```$/gm, ""));
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
            return (await this.getFiles("", ignores)).filter((e) => !e.startsWith(".trash/"));
        }
        return this.app.vault.getFiles().map((e) => e.path);
    }

    async createZip(verbosity: boolean, skippableFiles: string[] = [], onlyNew = false, skipDeleted: boolean = false) {
        const log = verbosity
            ? (msg: string, key?: string) => this.logWrite(msg, key)
            : (msg: string, key?: string) => this.logMessage(msg, key);

        const allFiles = await this.getAllFiles();
        const toc = await this.loadTOC();
        const today = new Date();
        const secondsInDay = ~~(today.getTime() / 1000 - today.getTimezoneOffset() * 60) % 86400;

        const newFileName = `${today.getFullYear()}-${today.getMonth() + 1}-${today.getDate()}-${secondsInDay}.zip`;

        // Find missing files
        let missingFiles = 0;
        for (const [filename, fileInfo] of Object.entries(toc)) {
            if (fileInfo.missing) continue;
            if (!(await this.vaultAccess.isFileExists(this.vaultAccess.normalizePath(filename)))) {
                if (skipDeleted) continue;
                fileInfo.missing = true;
                fileInfo.digest = "";
                fileInfo.mtime = today.getTime();
                fileInfo.processed = today.getTime();
                log(`File ${filename} is missing`);
                fileInfo.history = [
                    ...fileInfo.history,
                    {
                        zipName: newFileName,
                        modified: today.toISOString(),
                        missing: true,
                        processed: today.getTime(),
                        digest: "",
                    },
                ];
                log(`History of ${filename} has been updated (Missing)`);
                missingFiles++;
            }
        }

        const zip = new Archiver();

        const normalFiles = allFiles
            .filter(
                (e) =>
                    !e.startsWith(this.backupFolder + this.sep) && !e.startsWith(this.settings.restoreFolder + this.sep)
            )
            .filter((e) => skippableFiles.indexOf(e) == -1);
        let processed = 0;
        const processedFiles = [] as string[];
        let zipped = 0;
        for (const path of normalFiles) {
            processedFiles.push(path);
            processed++;
            if (processed % 10 == 0)
                this.logMessage(
                    `Backup processing ${processed}/${normalFiles.length}  ${verbosity ? `\n${path}` : ""}`,
                    "proc-zip-process"
                );
            // Retrieve the file information
            const stat = await this.vaultAccess.stat(path);
            if (!stat) {
                this.logMessage(`Archiving: Could not read stat ${path}`);
                continue;
            }
            // Check the file is in the skippable list
            if (onlyNew && path in toc) {
                const entry = toc[path];
                const mtime = new Date(stat.mtime).getTime();
                if (mtime <= entry.mtime) {
                    this.logWrite(`${path} older than the last backup, skipping`);
                    continue;
                }
            }
            // Read the file content
            const content = await this.vaultAccess.readBinary(path);
            if (!content) {
                this.logMessage(`Archiving: Could not read ${path}`);
                continue;
            }

            // Check the file actually modified.
            const f = new Uint8Array(content);
            const digest = await computeDigest(f);

            if (path in toc) {
                const entry = toc[path];
                if (entry.digest == digest) {
                    this.logWrite(`${path} Not changed`);
                    continue;
                }
            }
            zipped++;

            // Update the file information
            toc[path] = {
                digest,
                filename: path,
                mtime: stat.mtime,
                processed: today.getTime(),
                history: [
                    ...(toc[path]?.history ?? []),
                    {
                        zipName: newFileName,
                        modified: new Date(stat.mtime).toISOString(),
                        processed: today.getTime(),
                        digest,
                    },
                ],
            };
            this.logMessage(`Archiving: ${path} ${zipped}/${normalFiles.length}`, "proc-zip-archive");
            zip.addFile(f, path, { mtime: stat.mtime });
            if (this.settings.maxFilesInZip > 0 && zipped >= this.settings.maxFilesInZip) {
                this.logMessage(
                    `Max files in a single ZIP has been reached. The rest of the files will be archived in the next process`,
                    "finish"
                );
                break;
            }
        }
        this.logMessage(
            `All ${processed} files have been scanned, ${zipped} files are now compressing. please wait for a while`,
            "proc-zip-process"
        );
        if (zipped == 0 && missingFiles == 0) {
            this.logMessage(`Nothing has been changed! Generating ZIP has been skipped.`);
            return;
        }
        const tocTimeStamp = new Date().getTime();
        zip.addTextFile(`\`\`\`\n${stringifyYaml(toc)}\n\`\`\`\n`, InfoFile, { mtime: tocTimeStamp });
        try {
            const buf = await zip.finalize();
            // Writing a large file can cause the crash of Obsidian, and very heavy to synchronise.
            // Hence, we have to split the file into a smaller size.
            const step =
                this.settings.maxSize / 1 == 0 ? buf.byteLength + 1 : (this.settings.maxSize / 1) * 1024 * 1024;
            let pieceCount = 0;
            // If the file size is smaller than the step, it will be a single file.
            // Otherwise, it will be split into multiple files. (start from 001)
            if (buf.byteLength > step) pieceCount = 1;
            const chunks = pieces(buf, step);
            for (const chunk of chunks) {
                const outZipFile = this.backups.normalizePath(
                    `${this.backupFolder}${this.sep}${newFileName}${pieceCount == 0 ? "" : "." + `00${pieceCount}`.slice(-3)}`
                );
                pieceCount++;
                this.logMessage(`Creating ${outZipFile}...`, `proc-zip-process-write-${pieceCount}`);
                const e = await this.backups.writeBinary(outZipFile, chunk);
                if (!e) {
                    throw new Error(`Creating ${outZipFile} has been failed!`);
                }
                this.logMessage(`Creating ${outZipFile}...`, `proc-zip-process-write-${pieceCount}`);
            }

            const tocFilePath = this.backups.normalizePath(`${this.backupFolder}${this.sep}${InfoFile}`);

            // Update TOC
            if (
                !(await this.backups.writeTOC(
                    tocFilePath,
                    new TextEncoder().encode(`\`\`\`\n${stringifyYaml(toc)}\n\`\`\`\n`)
                ))
            ) {
                throw new Error(`Updating TOC has been failed!`);
            }
            log(`Backup information has been updated`);
            if (
                this.settings.maxFilesInZip > 0 &&
                zipped >= this.settings.maxFilesInZip &&
                this.settings.performNextBackupOnMaxFiles
            ) {
                setTimeout(() => {
                    this.createZip(verbosity, [...skippableFiles, ...processedFiles], onlyNew, skipDeleted);
                }, 10);
            } else {
                this.logMessage(
                    `All ${processed} files have been processed, ${zipped} files have been zipped.`,
                    "proc-zip-process"
                );
            }
            // } else {
            // 	this.logMessage(`Backup has been aborted \n${processed} files, ${zipped} zip files`, "proc-zip-process");
            // }
        } catch (e) {
            this.logMessage(
                `Something get wrong while processing ${processed} files, ${zipped} zip files`,
                "proc-zip-process"
            );
            this.logWrite(e);
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
            async (file: string, dat: Uint8Array) => {
                const fileName = restoreAs ?? file;
                const restoreTo = hasMultipleSupplied ? `${restorePrefix}${fileName}` : fileName;
                if (await this.vaultAccess.writeBinary(restoreTo, dat)) {
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
            for await (const chunk of chunks) {
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
            this.createZip(false, [], onlyNew, skipDeleted);
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
            callback: () => {
                this.createZip(true);
            },
        });
        this.addCommand({
            id: "b-create-diff-zip-only-new",
            name: "Create Differential Backup Only Newer Files",
            callback: () => {
                this.createZip(true, [], true);
            },
        });
        this.addCommand({
            id: "b-create-diff-zip-only-new-and-existing",
            name: "Create Non-Destructive Differential Backup",
            callback: () => {
                this.createZip(true, [], false, true);
            },
        });
        this.addCommand({
            id: "b-create-diff-zip-only-new-and-existing-only-new",
            name: "Create Non-Destructive Differential Backup Only Newer Files",
            callback: () => {
                this.createZip(true, [], true, true);
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
        this.addSettingTab(new DiffZipSettingTab(this.app, this));
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async resetToC() {
        const toc = {} as FileInfos;
        const tocFilePath = this.backups.normalizePath(`${this.backupFolder}${this.sep}${InfoFile}`);
        // Update TOC
        if (
            await this.backups.writeTOC(
                tocFilePath,
                new TextEncoder().encode(`\`\`\`\n${stringifyYaml(toc)}\n\`\`\`\n`)
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
