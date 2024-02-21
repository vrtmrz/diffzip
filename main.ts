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

interface DZBSettings {
	backupFolder: string;
	restoreFolder: string;
	maxSize: number;
	startBackupAtLaunch: boolean;
	includeHiddenFolder: boolean;
}
const InfoFile = `backupinfo.md`;
const DEFAULT_SETTINGS: DZBSettings = {
	startBackupAtLaunch: false,
	backupFolder: "backup",
	restoreFolder: "restored",
	includeHiddenFolder: false,
	maxSize: 30,
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


async function ensureDirectory(app: App, fullpath: string) {
	const pathElements = fullpath.split("/");
	pathElements.pop();
	let c = "";
	for (const v of pathElements) {
		c += v;
		try {
			await app.vault.createFolder(c);
		} catch (ex) {
			// basically skip exceptions.
			if (ex.message && ex.message == "Folder already exists.") {
				// especialy this message is.
			} else {
				new Notice("Folder Create Error");
				console.log(ex);
			}
		}
		c += "/";
	}
}

async function getFiles(
	app: App,
	path: string,
	ignoreList: string[]
) {
	const w = await app.vault.adapter.list(path);
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
		files = files.concat(await getFiles(app, v, ignoreList));
	}
	return files;
}

export default class DiffZipBackupPlugin extends Plugin {
	settings: DZBSettings;
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

	async loadTOC() {
		let toc = {} as FileInfos;
		const indexFile = this.app.vault.getAbstractFileByPath(
			normalizePath(`${this.settings.backupFolder}/${InfoFile}`)
		);
		if (indexFile && indexFile instanceof TFile) {
			this.logWrite(`Loading Backup information`, "proc-index");
			try {
				const tocStr = await this.app.vault.read(indexFile);
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
		await ensureDirectory(this.app, filename);
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
				await ensureDirectory(this.app, filename);
				await this.app.vault.createBinary(filename, content)
				return true;

			}
		} catch (ex) {
			console.dir(ex);
		}
		return false;
	}

	async createZip(verbosity: boolean) {
		const log = verbosity ? (msg: string, key?: string) => this.logWrite(msg, key) : (msg: string, key?: string) => this.logMessage(msg, key);
		const ignoreDirs = ["node_modules", ".git", this.app.vault.configDir + "/trash", this.app.vault.configDir + "/workspace.json", this.app.vault.configDir + "/workspace-mobile.json"];
		const allFiles = this.settings.includeHiddenFolder ? await getFiles(this.app, "", ignoreDirs) : this.app.vault.getFiles().map(e => e.path);
		// const allFiles = [...this.app.vault.getFiles()];
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
			}
			if (!err) {
				this.logWrite("Updating..");
				output.push(dat);
				if (final) {
					if (zipped == 0) {
						this.logMessage(
							`Nothing has been changed! Generating ZIP has been skipped.`
						);
						return;
					}
					const outZipBlob = new Blob(output);
					let i = 0;
					const buf = await outZipBlob.arrayBuffer();
					const step = (this.settings.maxSize / 1) == 0 ? buf.byteLength + 1 : ((this.settings.maxSize / 1)) * 1024 * 1024;
					let pieceCount = 0;
					if (buf.byteLength > step) pieceCount = 1;
					while (i < buf.byteLength) {
						const outZipFile = normalizePath(
							this.settings.backupFolder + "/" + newFileName + (pieceCount == 0 ? "" : ("." + (`00${pieceCount}`.slice(-3))))
						);
						pieceCount++;
						await ensureDirectory(this.app, outZipFile);
						this.app.vault.createBinary(
							outZipFile,
							buf.slice(i, i + step)
						);
						i += step;
						this.logMessage(
							`${outZipFile} has been created!`,
							"proc-zip-process"
						);
					}
					const tocFilePath = normalizePath(
						`${this.settings.backupFolder}/${InfoFile}`
					);
					let tocFile =
						this.app.vault.getAbstractFileByPath(tocFilePath);
					if (!tocFile || !(tocFile instanceof TFile)) {
						tocFile = await this.app.vault.create(tocFilePath, "");
					}
					if (tocFile instanceof TFile) {
						await this.app.vault.modify(
							tocFile,
							`\`\`\`\n${stringifyYaml(toc)}\n\`\`\`\n`
						);
					}
					log(`Backup information has been updated`);
				}
			}
		});
		const normalFiles = allFiles.filter(
			(e) => !e.startsWith(this.settings.backupFolder + "/") && !e.startsWith(this.settings.restoreFolder + "/") && !e.startsWith(".trash/")
		);
		let processed = 0;
		let zipped = 0;

		for (const path of normalFiles) {
			this.logMessage(
				`Backup processing ${processed}/${normalFiles.length}  ${verbosity ? `\n${path}` : ""}`,
				"proc-zip-process"
			);
			// const path = file;
			const content = await this.readFile(path);
			if (!content) {
				this.logMessage(
					`Archiving:Could not read ${path}`,
				);
				continue;
			}
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
	async extract(zipFile: string, extractFile: string, restoreAs: string) {
		const zipPath = normalizePath(`${this.settings.backupFolder}/${zipFile}`);
		const zipF = this.app.vault.getAbstractFileByPath(zipPath);
		let files = [];
		if (zipF instanceof TFile) {
			files = [zipF]
		} else {
			let hasNext = true;
			let counter = 0;
			do {
				counter++;
				const zipF = this.app.vault.getAbstractFileByPath(zipPath + "." + `00${counter}`.slice(-3));
				if (zipF instanceof TFile) {
					files.push(zipF);
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
		let extracted = false;
		unzipper.onfile = file => {
			// file.name is a string, file is a stream
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

			} else {
				// this.logMessage(
				// 	`${file.name} Skipped`,
				// 	"proc-zip-export-skip"
				// );
			}
		};
		let idx = 0;
		for (const f of files) {
			idx++;
			this.logMessage(
				`Processing ${f.name}...`,
				"proc-zip-export-processing"
			);
			const buf = new Uint8Array(await this.app.vault.readBinary(f));
			const step = 1024 * 1024; // Possibly fails
			let i = 0;
			while (i < buf.byteLength) {
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
		// unzipper.push(new Uint8Array(), true);
	}
	async onLayoutReady() {
		if (this.settings.startBackupAtLaunch) {
			this.createZip(false);
		}
	}
	async onload() {
		await this.loadSettings();
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
				const files = await this.loadTOC();
				const filenames = Object.entries(files).sort((a, b) => b[1].mtime - a[1].mtime).map(e => e[0]);
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
				const RESTORE_TO_RESTOREFOLDER = "Under the restore folder";
				const RESTORE_WITH_SUFFIX = "Original place but with ZIP name suffix";
				const restoreMethods = [RESTORE_TO_RESTOREFOLDER, RESTORE_OVERWRITE, RESTORE_WITH_SUFFIX]
				const howToRestore = await askSelectString(this.app, "Where to restore?", restoreMethods);
				const restoreAs = howToRestore == RESTORE_OVERWRITE ? selected : (
					howToRestore == RESTORE_TO_RESTOREFOLDER ? normalizePath(`${this.settings.restoreFolder}/${selected}`) :
						((howToRestore == RESTORE_WITH_SUFFIX) ? `${selectedWithoutExt}-${suffix}.${ext}` : "")
				)
				if (!restoreAs) {
					return;
				}

				await this.extract(filename, selected, restoreAs);

			},
		})
		this.addSettingTab(new SampleSettingTab(this.app, this));
	}

	onunload() { }

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

class SampleSettingTab extends PluginSettingTab {
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
			// .setDesc("")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.startBackupAtLaunch)
					.onChange(async (value) => {
						this.plugin.settings.startBackupAtLaunch = value;
						await this.plugin.saveSettings();
					})
			);
		new Setting(containerEl)
			.setName("Backup folder")
			.setDesc("Folder to keep each backup ZIPs and information file")
			.addText((text) =>
				text
					.setPlaceholder("backup")
					.setValue(this.plugin.settings.backupFolder)
					.onChange(async (value) => {
						this.plugin.settings.backupFolder = value;
						await this.plugin.saveSettings();
					})
			);
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


export class PopoverSelectString extends FuzzySuggestModal<string> {
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

export const askSelectString = (app: App, message: string, items: string[]): Promise<string> => {
	const getItemsFun = () => items;
	return new Promise((res) => {
		const popover = new PopoverSelectString(app, message, "", getItemsFun, (result) => res(result));
		popover.open();
	});
};
