import type { PlatformPath } from "node:path";
import {
	App,
	FuzzySuggestModal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	normalizePath,
	parseYaml,
	stringifyYaml,
} from "obsidian";
import * as fflate from "fflate";

const InfoFile = `backupinfo.md`;

interface DiffZipBackupSettings {
	backupFolder?: string;
	backupFolderMobile: string;
	restoreFolder: string;
	maxSize: number;
	startBackupAtLaunch: boolean;
	includeHiddenFolder: boolean;
	desktopFolderEnabled: boolean;
	BackupFolderDesktop: string;
}

const DEFAULT_SETTINGS: DiffZipBackupSettings = {
	startBackupAtLaunch: false,
	backupFolderMobile: "backup",
	BackupFolderDesktop: "c:\\temp\\backup",
	restoreFolder: "restored",
	includeHiddenFolder: false,
	maxSize: 30,
	desktopFolderEnabled: false
};

type FileInfo = {
	filename: string;
	digest: string;
	history: { zipName: string, modified: string }[];
	mtime: number;
};
type FileInfos = Record<string, FileInfo>;

type NoticeWithTimer = {
	notice: Notice;
	timer?: ReturnType<typeof setTimeout>;
};

async function computeDigest(data: Uint8Array) {
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	const hashHex = hashArray
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return hashHex;
}

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
		return this.isDesktopMode ? this.settings.BackupFolderDesktop : this.settings.backupFolderMobile;
	}

	get sep(): string {
		//@ts-ignore
		return this.isDesktopMode ? this.app.vault.adapter.path.sep : "/";
	}

	messages = {} as Record<string, NoticeWithTimer>;

	// #region Log
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

	// #endregion log

	async ensureDirectory(fullPath: string) {
		const pathElements = fullPath.split(this.sep);
		pathElements.pop();
		let c = "";
		for (const v of pathElements) {
			c += v;
			try {
				await this.app.vault.createFolder(c);
			} catch (ex) {
				// basically skip exceptions.
				if (ex.message && ex.message == "Folder already exists.") {
					// especial this message is.
				} else {
					new Notice("Folder Create Error");
					console.log(ex);
				}
			}
			c += this.sep;
		}
	}
	async ensureDirectoryDesktop(fullPath: string) {

		//@ts-ignore
		const delimiter = await this.app.vault.adapter.path.sep as string;
		const pathElements = fullPath.split(delimiter);
		pathElements.pop();
		const mkPath = pathElements.join(delimiter);
		//@ts-ignore
		await this.app.vault.adapter.fsPromises.mkdir(mkPath, { recursive: true });
	}

	async writeBinaryDesktop(fullPath: string, data: ArrayBuffer) {
		//@ts-ignore
		await this.app.vault.adapter.fsPromises.writeFile(fullPath, Buffer.from(data));
	}
	async getFiles(
		path: string,
		ignoreList: string[]
	) {
		const w = await this.app.vault.adapter.list(path);
		let files = [
			...w.files
				.filter((e) => !ignoreList.some((ee) => e.endsWith(ee)))
		];
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

	async normalizePath(path: string) {
		if (this.settings.desktopFolderEnabled && !this.isMobile) {
			//@ts-ignore
			const f = this.app.vault.adapter.path as PlatformPath;
			return f.normalize(path);
		} else {
			return normalizePath(path);
		}
	}
	async loadTOC() {
		let toc = {} as FileInfos;
		const tocFilePath = await this.normalizePath(`${this.backupFolder}${this.sep}${InfoFile}`);
		const tocExist = await this.isExists(tocFilePath);

		if (tocExist) {
			this.logWrite(`Loading Backup information`, "proc-index");
			try {
				const tocBin = await this.readBinaryAuto(tocFilePath);
				if (tocBin == null) {
					this.logMessage(
						`LOAD ERROR: Could not read Backup information`,
						"proc-index"
					);
					return {}
				}
				const tocStr = new TextDecoder().decode(tocBin);
				toc = parseYaml(tocStr.replace(/^```$/gm, ""));
				if (toc == null) {
					this.logMessage(
						`PARSE ERROR: Could not parse Backup information`,
						"proc-index"
					);
					toc = {};
				} else {
					this.logWrite(
						`Backup information has been loaded`,
						"proc-index"
					);
				}
			} catch (ex) {
				this.logMessage(
					`Something went wrong while parsing Backup information`,
					"proc-index"
				);
				console.warn(ex);
				toc = {};
			}
		} else {
			this.logMessage(`Backup information looks missing`, "proc-index");
		}
		return toc;
	}

	async getAllFiles() {
		const ignores = ["node_modules", ".git", this.app.vault.configDir + "/trash", this.app.vault.configDir + "/workspace.json", this.app.vault.configDir + "/workspace-mobile.json"];
		if (this.settings.includeHiddenFolder) {
			return (await this.getFiles("", ignores)).filter(e => !e.startsWith(".trash/"))
		}
		return this.app.vault.getFiles().map(e => e.path);
	}

	async readFile(filename: string) {
		if (this.settings.includeHiddenFolder) {
			return await this.app.vault.adapter.readBinary(filename);
		} else {
			const f = this.app.vault.getAbstractFileByPath(filename);
			if (f instanceof TFile) {
				return await this.app.vault.readBinary(f);
			}
		}
		return null;
	}
	async readStat(filename: string) {
		if (this.settings.includeHiddenFolder) {
			return await this.app.vault.adapter.stat(filename);
		} else {
			const f = this.app.vault.getAbstractFileByPath(filename);
			if (f instanceof TFile) {
				return f.stat;
			}
		}
		return null;
	}
	async writeFileBinary(filename: string, content: ArrayBuffer) {
		await this.ensureDirectory(filename);
		await this.app.vault.adapter.writeBinary(filename, content);
		return true;
	}
	async writeFile(filename: string, content: ArrayBuffer) {
		try {
			const f = this.app.vault.getAbstractFileByPath(filename);
			if (f instanceof TFile) {
				await this.app.vault.modifyBinary(f, content);
				return true;
			} else if (f == null) {
				// If it could not get by getAbstractFileByPath, try adapter function once.
				try {
					const stat = await this.app.vault.adapter.stat(filename);
					if (stat?.type == "file") {
						return await this.writeFileBinary(filename, content);
					} else if (stat?.type == "folder") {
						return false;
					}
				} catch (ex) {
					//NO OP.
				}
				await this.ensureDirectory(filename);
				await this.app.vault.createBinary(filename, content)
				return true;

			}
		} catch (ex) {
			console.dir(ex);
		}
		return false;
	}

	async writeBinaryAuto(filename: string, content: ArrayBuffer) {
		if (this.isDesktopMode) {
			await this.ensureDirectoryDesktop(filename);
			await this.writeBinaryDesktop(filename, content);
		} else {
			await this.ensureDirectory(filename);
			const theFile = this.app.vault.getAbstractFileByPath(filename);
			if (theFile == null) {
				await this.app.vault.createBinary(filename, content)
			} else {
				await this.app.vault.modifyBinary(theFile as TFile, content)
			}
		}
	}

	async createZip(verbosity: boolean) {
		const log = verbosity ? (msg: string, key?: string) => this.logWrite(msg, key) : (msg: string, key?: string) => this.logMessage(msg, key);

		const allFiles = await this.getAllFiles();
		const toc = await this.loadTOC();
		const today = new Date();
		const secondsInDay =
			~~(today.getTime() / 1000 - today.getTimezoneOffset() * 60) % 86400;

		const newFileName = `${today.getFullYear()}-${today.getMonth() + 1
			}-${today.getDate()}-${secondsInDay}.zip`;
		const output = [] as Uint8Array[];
		const zip = new fflate.Zip(async (err, dat, final) => {
			if (err) {
				console.dir(err);
				this.logMessage("Something occurred while archiving the backup, please check the result once");
				return;
			}
			if (!err) {
				this.logWrite("Updating ZIP..");
				output.push(dat);
				if (final) {
					if (zipped == 0) {
						this.logMessage(
							`Nothing has been changed! Generating ZIP has been skipped.`
						);
						return;
					}
					// Generate all concatenated Blob
					const outZipBlob = new Blob(output);
					let i = 0;
					const buf = await outZipBlob.arrayBuffer();

					// Writing a large file can cause the crash of Obsidian, and very heavy to synchronise.
					// Hence, we have to split the file into a smaller size.
					const step = (this.settings.maxSize / 1) == 0 ? buf.byteLength + 1 : ((this.settings.maxSize / 1)) * 1024 * 1024;
					let pieceCount = 0;
					if (buf.byteLength > step) pieceCount = 1;
					while (i < buf.byteLength) {
						const outZipFile = await this.normalizePath(`${this.backupFolder}${this.sep}${newFileName}${pieceCount == 0 ? "" : ("." + (`00${pieceCount}`.slice(-3)))}`)
						pieceCount++;
						this.writeBinaryAuto(outZipFile, buf.slice(i, i + step));
						i += step;
						this.logMessage(
							`${outZipFile} has been created!`,
							"proc-zip-process"
						);
					}
					const tocFilePath = await this.normalizePath(
						`${this.backupFolder}${this.sep}${InfoFile}`
					);
					// Update TOC
					await this.writeBinaryAuto(tocFilePath, new TextEncoder().encode(`\`\`\`\n${stringifyYaml(toc)}\n\`\`\`\n`));
					log(`Backup information has been updated`);
				}
			}
		});
		const normalFiles = allFiles.filter(
			(e) => !e.startsWith(this.backupFolder + this.sep) && !e.startsWith(this.settings.restoreFolder + this.sep)
		);
		let processed = 0;
		let zipped = 0;

		for (const path of normalFiles) {
			this.logMessage(
				`Backup processing ${processed}/${normalFiles.length}  ${verbosity ? `\n${path}` : ""}`,
				"proc-zip-process"
			);
			const content = await this.readFile(path);
			if (!content) {
				this.logMessage(
					`Archiving:Could not read ${path}`,
				);
				continue;
			}
			// Check the file actually modified.
			const f = new Uint8Array(content);
			const digest = await computeDigest(f);
			processed++;
			if (path in toc) {
				const entry = toc[path];
				if (entry.digest == digest) {
					this.logWrite(
						`${path} Not changed`
					);
					continue;
				}
			}
			zipped++;
			const stat = await this.readStat(path);
			if (!stat) {
				this.logMessage(
					`Archiving:Could not read stat ${path}`,
				);
				continue;
			}
			toc[path] = {
				digest,
				filename: path,
				mtime: stat.mtime,
				history: [...toc[path]?.history ?? [], { zipName: newFileName, modified: new Date(stat.mtime).toISOString() }],
			};
			const fflateFile = new fflate.ZipDeflate(path, {
				level: 9,
			});
			fflateFile.mtime = stat.mtime;
			this.logMessage(
				`Archiving:${path} ${zipped}/${normalFiles.length}`,
				"proc-zip-archive"
			);
			zip.add(fflateFile);
			fflateFile.push(f, true);
		}
		this.logMessage(
			`All ${processed} files have been scanned, ${zipped} files are now compressing. please wait for a while`,
			"proc-zip-process"
		);
		const fflateFile = new fflate.ZipDeflate(InfoFile, {
			level: 9,
		});
		zip.add(fflateFile);
		const t = new TextEncoder();
		fflateFile.push(t.encode("```\n" + stringifyYaml(toc) + "\n```"), true);
		zip.end();
	}

	async isExists(path: string) {
		if (this.isDesktopMode) {
			try {
				//@ts-ignore
				const _ = await this.app.vault.adapter.fsPromises.stat(path);
				return true;
			} catch (ex) {
				// NO OP.
			}
			return false;
		} else {
			return this.app.vault.getAbstractFileByPath(path) != null;
		}
	}
	async readBinaryAuto(path: string): Promise<ArrayBuffer | null> {
		if (this.isDesktopMode) {
			//@ts-ignore
			return (await this.app.vault.adapter.fsPromises.readFile(path)).buffer;
		} else {
			const f = this.app.vault.getAbstractFileByPath(path);
			if (f instanceof TFile) {
				return await this.app.vault.readBinary(f);
			}
		}
		return null;
	}

	async extract(zipFile: string, extractFile: string, restoreAs: string) {
		const zipPath = await this.normalizePath(`${this.backupFolder}${this.sep}${zipFile}`);
		const zipF = await this.isExists(zipPath);
		let files = [] as string[];
		if (zipF) {
			files = [zipPath]
		} else {
			let hasNext = true;
			let counter = 0;
			do {
				counter++;
				const partialZipPath = zipPath + "." + `00${counter}`.slice(-3)
				if (await this.isExists(partialZipPath)) {
					files.push(partialZipPath);
				} else {
					hasNext = false;
				}
			} while (hasNext)
		}
		if (files.length == 0) {
			this.logMessage("Archived ZIP files were not found!");
		}
		const unzipper = new fflate.Unzip();
		unzipper.register(fflate.UnzipInflate);

		// When the target file has been extracted, extracted will be true.
		let extracted = false;
		unzipper.onfile = file => {
			if (file.name == extractFile) {
				this.logMessage(
					`${file.name} Found`,
					"proc-zip-export"
				);
				file.ondata = async (_, dat, __) => {
					extracted = true;
					// Stream output here
					this.logMessage(
						`${file.name} Read`,
						"proc-zip-export"
					);
					if (await this.writeFile(restoreAs, dat.buffer)) {
						this.logMessage(
							`${file.name} has been overwritten!`,
							"proc-zip-export"
						);
					} else {
						this.logMessage(
							`Creating or Overwriting ${file.name} has been failed!`,
							"proc-zip-export"
						);
					}
				};

				this.logMessage(
					`${file.name} Reading...`,
					"proc-zip-export"
				);
				file.start();
			}
		};
		let idx = 0;
		for (const f of files) {
			idx++;
			this.logMessage(
				`Processing ${f}...`,
				"proc-zip-export-processing"
			);
			const binary = await this.readBinaryAuto(f);
			if (binary == null) {
				this.logMessage(
					`Could not read ${f}`,
					"proc-zip-export-processing"
				);
				return;
			}
			const buf = new Uint8Array(binary);
			const step = 1024 * 1024; // Possibly fails
			let i = 0;
			while (i < buf.byteLength) {
				// If already extract has completed, stop parsing subsequent chunks
				const isCompleted = extracted || (i + step > buf.byteLength && idx == files.length);
				unzipper.push(buf.slice(i, i + step), isCompleted);
				if (extracted) break;
				i += step;
			}
			if (extracted) break;
		}
		this.logMessage(
			`All ZIP files has been read.`,
			"proc-zip-export-processing"
		);
	}

	async selectAndRestore() {
		const files = await this.loadTOC();
		const filenames = Object.entries(files).sort((a, b) => b[1].mtime - a[1].mtime).map(e => e[0]);
		if (filenames.length == 0) {
			return;
		}
		const selected = await askSelectString(this.app, "Select file", filenames);
		if (!selected) {
			return;
		}
		const revisions = files[selected].history;
		const d = `\u{2063}`;
		const revisionList = revisions.map(e => `${e.zipName}${d} (${e.modified})`).reverse();
		const selectedTimestamp = await askSelectString(this.app, "Select file", revisionList);
		if (!selectedTimestamp) {
			return;
		}
		const [filename,] = selectedTimestamp.split(d);
		const suffix = filename.replace(".zip", "");
		// No cares about without extension
		const extArr = selected.split(".");
		const ext = extArr.pop();
		const selectedWithoutExt = extArr.join(".");
		const RESTORE_OVERWRITE = "Original place and okay to overwrite";
		const RESTORE_TO_RESTORE_FOLDER = "Under the restore folder";
		const RESTORE_WITH_SUFFIX = "Original place but with ZIP name suffix";
		const restoreMethods = [RESTORE_TO_RESTORE_FOLDER, RESTORE_OVERWRITE, RESTORE_WITH_SUFFIX]
		const howToRestore = await askSelectString(this.app, "Where to restore?", restoreMethods);
		const restoreAs = howToRestore == RESTORE_OVERWRITE ? selected : (
			howToRestore == RESTORE_TO_RESTORE_FOLDER ? await this.normalizePath(`${this.settings.restoreFolder}${this.sep}${selected}`) :
				((howToRestore == RESTORE_WITH_SUFFIX) ? `${selectedWithoutExt}-${suffix}.${ext}` : "")
		)
		if (!restoreAs) {
			return;
		}
		await this.extract(filename, selected, restoreAs);
	}

	async onLayoutReady() {
		if (this.settings.startBackupAtLaunch) {
			this.createZip(false);
		}
	}
	async onload() {
		await this.loadSettings();
		if ("backupFolder" in this.settings) {
			this.settings.backupFolderMobile = this.settings.backupFolder as string;
			delete this.settings.backupFolder;
		}
		this.app.workspace.onLayoutReady(() => this.onLayoutReady())
		this.addCommand({
			id: "create-diff-zip",
			name: "Create Differential Backup",
			callback: () => {
				this.createZip(true);
			},
		});
		this.addCommand({
			id: "find-from-backups",
			name: "Restore from backups",
			callback: async () => {
				await this.selectAndRestore();
			},
		})
		this.addSettingTab(new DiffZipSettingTab(this.app, this));
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class DiffZipSettingTab extends PluginSettingTab {
	plugin: DiffZipBackupPlugin;

	constructor(app: App, plugin: DiffZipBackupPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();
		new Setting(containerEl)
			.setName("Start backup at launch")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.startBackupAtLaunch)
					.onChange(async (value) => {
						this.plugin.settings.startBackupAtLaunch = value;
						await this.plugin.saveSettings();
					})
			);
		if (!this.plugin.isMobile) {
			new Setting(containerEl)
				.setName("Use desktop Mode (Bleeding Edge)")
				.setDesc("We can use external folder of Obsidian only if on desktop and it is enabled. This feature uses Internal API.")
				.setDisabled(this.plugin.isMobile)
				.addToggle((toggle) =>
					toggle
						.setValue(this.plugin.settings.desktopFolderEnabled)
						.onChange(async (value) => {
							this.plugin.settings.desktopFolderEnabled = value;
							await this.plugin.saveSettings();
							this.display();
						})
				);
		}
		if (!this.plugin.isDesktopMode) {
			new Setting(containerEl)
				.setName("Backup folder")
				.setDesc("Folder to keep each backup ZIPs and information file")
				.addText((text) =>
					text
						.setPlaceholder("backup")
						.setValue(this.plugin.settings.backupFolderMobile)
						.onChange(async (value) => {
							this.plugin.settings.backupFolderMobile = value;
							await this.plugin.saveSettings();
						})
				);

		}
		if (this.plugin.isDesktopMode) {
			new Setting(containerEl)
				.setName("Backup folder (desktop)")
				.setDesc("Folder to keep each backup ZIPs and information file")
				.addText((text) =>
					text
						.setPlaceholder("c:\\temp\\backup")
						.setValue(this.plugin.settings.BackupFolderDesktop)
						.setDisabled(!this.plugin.settings.desktopFolderEnabled)
						.onChange(async (value) => {
							this.plugin.settings.BackupFolderDesktop = value;
							await this.plugin.saveSettings();
						})
				)
		}

		new Setting(containerEl)
			.setName("Restore folder")
			.setDesc("Folder to save the restored file")
			.addText((text) =>
				text
					.setPlaceholder("restored")
					.setValue(this.plugin.settings.restoreFolder)
					.onChange(async (value) => {
						this.plugin.settings.restoreFolder = value;
						await this.plugin.saveSettings();
					})
			);
		new Setting(containerEl)
			.setName("Include hidden folders")
			.setDesc("node_modules, .git, and trash of Obsidian are ignored automatically")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.includeHiddenFolder)
					.onChange(async (value) => {
						this.plugin.settings.includeHiddenFolder = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("ZIP splitting size")
			.setDesc("(MB) Size to split backup zip file")
			.addText((text) =>
				text
					.setPlaceholder("30")
					.setValue(this.plugin.settings.maxSize + "")
					.onChange(async (value) => {
						this.plugin.settings.maxSize = Number.parseInt(value);
						await this.plugin.saveSettings();
					})
			);
	}
}


class PopOverSelectString extends FuzzySuggestModal<string> {
	app: App;
	callback?: (e: string) => void = () => { };
	getItemsFun: () => string[] = () => {
		return ["yes", "no"];

	}

	constructor(app: App, note: string, placeholder: string | null, getItemsFun: () => string[], callback: (e: string) => void) {
		super(app);
		this.app = app;
		this.setPlaceholder((placeholder ?? "y/n) ") + note);
		if (getItemsFun) this.getItemsFun = getItemsFun;
		this.callback = callback;
	}

	getItems(): string[] {
		return this.getItemsFun();
	}

	getItemText(item: string): string {
		return item;
	}

	onChooseItem(item: string, evt: MouseEvent | KeyboardEvent): void {
		// debugger;
		this.callback?.(item);
		this.callback = undefined;
	}
	onClose(): void {
		setTimeout(() => {
			if (this.callback != undefined) {
				this.callback("");
			}
		}, 100);
	}
}

const askSelectString = (app: App, message: string, items: string[]): Promise<string> => {
	const getItemsFun = () => items;
	return new Promise((res) => {
		const popOver = new PopOverSelectString(app, message, "", getItemsFun, (result) => res(result));
		popOver.open();
	});
};
