import {
	App,
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
	maxSize: number;
}
const InfoFile = `backupinfo.md`;
const DEFAULT_SETTINGS: DZBSettings = {
	backupFolder: "backup",
	maxSize: 30,
};

type FileInfo = {
	filename: string;
	digest: string;
	storedIn: string;
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

	async createZip() {
		const allFiles = [...this.app.vault.getFiles()];
		let toc = {} as FileInfos;
		const indexFile = this.app.vault.getAbstractFileByPath(
			normalizePath(`${this.settings.backupFolder}/${InfoFile}`)
		);
		if (indexFile && indexFile instanceof TFile) {
			this.logMessage(`Loading Backup information`, "proc-index");
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
					this.logMessage(
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
						this.app.vault.createBinary(
							outZipFile,
							buf.slice(i, i + step)
						);
						i += step;
						this.logMessage(
							`${outZipFile} has been created!`,
							"proc-zip-archive"
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
					this.logMessage(`Backup information has been updated`);
				}
			}
		});
		const normalFiles = allFiles.filter(
			(e) => !e.path.startsWith(this.settings.backupFolder + "/")
		);
		let processed = 0;
		let zipped = 0;

		for (const file of normalFiles) {
			this.logMessage(
				`Processing:${file.path} ${processed}/${normalFiles.length}`,
				"proc-zip-process"
			);
			const path = file.path;
			const f = new Uint8Array(await this.app.vault.readBinary(file));
			const digest = await computeDigest(f);
			processed++;
			if (path in toc) {
				this.logWrite("Already in index");
				const entry = toc[path];
				if (entry.digest == digest) {
					this.logWrite(
						`old file digest:${entry.digest}, this:${digest}, not changed`
					);
					continue;
				}
			}
			zipped++;
			toc[path] = {
				digest,
				filename: path,
				mtime: file.stat.mtime,
				storedIn: newFileName,
			};
			const fflateFile = new fflate.ZipDeflate(file.path, {
				level: 9,
			});
			fflateFile.mtime = file.stat.mtime;
			this.logMessage(
				`Archiving:${file.path} ${zipped}/${normalFiles.length}`,
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

	async onload() {
		await this.loadSettings();
		this.addCommand({
			id: "create-diff-zip",
			name: "Create Differential Backup Zip",
			callback: () => {
				this.createZip();
			},
		});
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
			.setName("Backup dir")
			.setDesc("Folder to keep Backup ZIP and information file")
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
			.setName("Source Size Cap")
			.setDesc("(MB) Total size to stop zipping")
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
