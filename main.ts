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
import { S3 } from '@aws-sdk/client-s3';
import { ObsHttpHandler } from "./ObsHttpHandler";
import { decryptCompatOpenSSL, encryptCompatOpenSSL } from "./aes";

const InfoFile = `backupinfo.md`;

interface DiffZipBackupSettings {
	backupFolder?: string;
	backupFolderMobile: string;
	backupFolderBucket: string;
	restoreFolder: string;
	maxSize: number;
	maxFilesInZip: number;
	performNextBackupOnMaxFiles: boolean;
	startBackupAtLaunch: boolean;
	includeHiddenFolder: boolean;
	desktopFolderEnabled: boolean;
	BackupFolderDesktop: string;
	bucketEnabled: boolean;

	endPoint: string,
	accessKey: string,
	secretKey: string,
	bucket: string,
	region: string,
	passphraseOfFiles: string;
	passphraseOfZip: string;
	useCustomHttpHandler: boolean;
}

const DEFAULT_SETTINGS: DiffZipBackupSettings = {
	startBackupAtLaunch: false,
	backupFolderMobile: "backup",
	BackupFolderDesktop: "c:\\temp\\backup",
	backupFolderBucket: "backup",
	restoreFolder: "restored",
	includeHiddenFolder: false,
	maxSize: 30,
	desktopFolderEnabled: false,
	bucketEnabled: false,
	endPoint: '',
	accessKey: '',
	secretKey: '',
	region: "",
	bucket: "diffzip",
	maxFilesInZip: 100,
	performNextBackupOnMaxFiles: true,
	useCustomHttpHandler: false,
	passphraseOfFiles: "",
	passphraseOfZip: "",
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
		if (this.settings.bucketEnabled) return this.settings.backupFolderBucket;
		return this.isDesktopMode ? this.settings.BackupFolderDesktop : this.settings.backupFolderMobile;
	}

	get sep(): string {
		//@ts-ignore
		return this.isDesktopMode ? this.app.vault.adapter.path.sep : "/";
	}

	async getClient() {
		const client = new S3({
			endpoint: this.settings.endPoint,
			region: this.settings.region,
			forcePathStyle: true,
			credentials: {
				accessKeyId: this.settings.accessKey,
				secretAccessKey: this.settings.secretKey
			},
			requestHandler: this.settings.useCustomHttpHandler ? new ObsHttpHandler(undefined, undefined) : undefined
		})
		return client;
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

	async ensureDirectory(fullPath: string) {
		const pathElements = fullPath.split("/");
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
			c += "/";
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
	async writeBinaryS3(fullPath: string, data: ArrayBuffer) {
		const client = await this.getClient();
		await client.putObject({
			Bucket: this.settings.bucket,
			Key: fullPath,
			Body: new Uint8Array(data),
		});
	}
	async readBinaryS3(fullPath: string) {
		const client = await this.getClient();
		const result = await client.getObject({
			Bucket: this.settings.bucket,
			Key: fullPath,
		});
		if (!result.Body) return false;
		return await result.Body.transformToByteArray();
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
		} else if (this.settings.bucketEnabled) {
			return path;
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

	async readVaultFile(filename: string) {
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
	async readVaultStat(filename: string) {
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
	async writeFileBinary(filename: string, content: ArrayBuffer) {
		await this.ensureDirectory(filename);
		await this.app.vault.adapter.writeBinary(filename, content);
		return true;
	}
	async writeBinaryAuto(filename: string, contentSource: ArrayBuffer) {
		let content;
		if (this.settings.passphraseOfZip) {
			content = await encryptCompatOpenSSL(new Uint8Array(contentSource), this.settings.passphraseOfZip);
		} else {
			content = contentSource;
		}
		try {
			if (this.isDesktopMode) {
				await this.ensureDirectoryDesktop(filename);
				await this.writeBinaryDesktop(filename, content);
			} else if (this.settings.bucketEnabled) {
				await this.writeBinaryS3(filename, content);
			} else {
				await this.ensureDirectory(filename);
				const theFile = this.app.vault.getAbstractFileByPath(filename);
				if (theFile == null) {
					await this.app.vault.createBinary(filename, content)
				} else {
					await this.app.vault.modifyBinary(theFile as TFile, content)
				}
			}
			return true;
		} catch (ex) {
			this.logMessage(`Could not write ${filename}`);
			return false;
		}
	}

	async createZip(verbosity: boolean, skippableFiles: string[] = []) {
		const log = verbosity ? (msg: string, key?: string) => this.logWrite(msg, key) : (msg: string, key?: string) => this.logMessage(msg, key);

		const allFiles = await this.getAllFiles();
		const toc = await this.loadTOC();
		const today = new Date();
		const secondsInDay =
			~~(today.getTime() / 1000 - today.getTimezoneOffset() * 60) % 86400;

		const newFileName = `${today.getFullYear()}-${today.getMonth() + 1
			}-${today.getDate()}-${secondsInDay}.zip`;
		const output = [] as Uint8Array[];
		let aborted = false;
		let finished = false;
		const finishCompressing = async (abort: boolean) => {
			if (finished) return;
			finished = true;
			aborted = abort;
			if (!aborted) {
				if (this.settings.maxFilesInZip > 0 && zipped >= this.settings.maxFilesInZip && this.settings.performNextBackupOnMaxFiles) {
					setTimeout(() => {
						this.createZip(verbosity, [...skippableFiles, ...processedFiles]);
					}, 10);
				}
			} else {
				this.logMessage(
					`Something get wrong while processing ${processed} files, ${zipped} zip files`,
					"proc-zip-process"
				);
			}
		}
		const zip = new fflate.Zip(async (err, dat, final) => {
			if (err) {
				console.dir(err);
				this.logMessage("Something occurred while archiving the backup, please check the result once");
				return;
			}
			if (!err) {
				this.logWrite("Updating ZIP..");
				output.push(dat);
				if (aborted) return;
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
						this.logMessage(`Creating ${outZipFile}...`, `proc-zip-process-write-${pieceCount}`);
						const e = await this.writeBinaryAuto(outZipFile, buf.slice(i, i + step));
						if (e) {
							this.logMessage(
								`${outZipFile} has been created!`,
								`proc-zip-process-write-${pieceCount}`);
						} else {
							this.logMessage(
								`Creating ${outZipFile} has been failed!`,
								`proc-zip-process-write-${pieceCount}`);
							finishCompressing(true);
							break;
						}
						i += step;
						this.logMessage(
							`${outZipFile} has been created!`,
							`proc-zip-process-write-${pieceCount}`);
					}
					const tocFilePath = await this.normalizePath(
						`${this.backupFolder}${this.sep}${InfoFile}`
					);
					if (aborted) return;
					// Update TOC
					if (!await this.writeBinaryAuto(tocFilePath, new TextEncoder().encode(`\`\`\`\n${stringifyYaml(toc)}\n\`\`\`\n`))) {
						finishCompressing(true);
					}
					log(`Backup information has been updated`);
					finishCompressing(false);
				}
			}
		});
		const normalFiles = allFiles.filter(
			(e) => !e.startsWith(this.backupFolder + this.sep) && !e.startsWith(this.settings.restoreFolder + this.sep)
		).filter(e => skippableFiles.indexOf(e) == -1);
		let processed = 0;
		const processedFiles = [] as string[];
		let zipped = 0;
		for (const path of normalFiles) {
			if (aborted) break;
			processedFiles.push(path);
			this.logMessage(
				`Backup processing ${processed}/${normalFiles.length}  ${verbosity ? `\n${path}` : ""}`,
				"proc-zip-process"
			);
			const content = await this.readVaultFile(path);
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
			const stat = await this.readVaultStat(path);
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
		} else if (this.settings.bucketEnabled) {
			const client = await this.getClient();
			try {
				await client.headObject({
					Bucket: this.settings.bucket,
					Key: path,
				});
				return true;
			} catch (ex) {
				return false
			}
		} else {
			return this.app.vault.getAbstractFileByPath(path) != null;
		}
	}
	async readBinaryAuto(path: string): Promise<ArrayBuffer | null> {
		const encryptedData = await this.readBinaryAuto_(path);
		if (!encryptedData) return null;
		if (this.settings.passphraseOfZip) {
			return await decryptCompatOpenSSL(new Uint8Array(encryptedData), this.settings.passphraseOfZip);
		}
		return encryptedData;
	}
	async readBinaryAuto_(path: string): Promise<ArrayBuffer | null> {
		if (this.isDesktopMode) {
			//@ts-ignore
			return (await this.app.vault.adapter.fsPromises.readFile(path)).buffer;
		} else if (this.settings.bucketEnabled) {
			const r = await this.readBinaryS3(path);
			if (!r) return null;
			return r.buffer;
		} else {
			const f = this.app.vault.getAbstractFileByPath(path);
			if (f instanceof TFile) {
				return await this.app.vault.readBinary(f);
			}
		}
		return null;
	}

	async extract(zipFile: string, extractFiles: string[]): Promise<void>
	async extract(zipFile: string, extractFiles: string, restoreAs?: string): Promise<void>
	async extract(zipFile: string, extractFiles: string | string[], restoreAs?: string): Promise<void> {
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
		const targets = typeof extractFiles == "string" ? [extractFiles] : extractFiles;
		// When the target file has been extracted, extracted will be true.
		let extracted = false;
		unzipper.onfile = file => {
			if (targets.indexOf(file.name) !== -1) {
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
					const restoreTo = restoreAs ? restoreAs : file.name;
					if (await this.writeFile(restoreTo, dat.buffer)) {
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
			howToRestore == RESTORE_TO_RESTORE_FOLDER ? normalizePath(`${this.settings.restoreFolder}${this.sep}${selected}`) :
				((howToRestore == RESTORE_WITH_SUFFIX) ? `${selectedWithoutExt}-${suffix}.${ext}` : "")
		)
		if (!restoreAs) {
			return;
		}
		await this.extract(filename, selected, restoreAs);
	}

	async pickRevisions(files: FileInfos, prefix = ""): Promise<string> {
		const BACK = "[..]";
		const timestamps = new Set<string>();
		const all = Object.entries(files).filter(e => e[0].startsWith(prefix));
		for (const f of all) {
			f[1].history.map(e => e.modified).map(e => timestamps.add(e));
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
		const level = prefix.split("/").filter(e => !!e).length + 1;
		const filenamesAll = Object.entries(files).sort((a, b) => b[1].mtime - a[1].mtime).map(e => e[0]);
		const filenamesFiltered = filenamesAll.filter(e => e.startsWith(prefix));
		const filenamesA = filenamesFiltered.map(e => {
			const paths = e.split("/");
			const name = paths.splice(0, level).join("/");
			if (paths.length == 0 && name) return name;
			return `${name}/`;
		}).sort((a, b) => {
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
		filenames.unshift(BACK)


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
			const allFiles = Object.entries(files).filter(e => e[0].startsWith(prefix));
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
			if (await askSelectString(this.app, `Are you sure to restore(Overwrite) ${filesCount} files from ${zipList.length} ZIPs`, ["Y", "N"]) != "Y") {
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
		const revisionList = revisions.map(e => `${e.zipName}${d} (${e.modified})`).reverse();
		revisionList.unshift(BACK);
		const selectedTimestamp = await askSelectString(this.app, "Select file", revisionList);
		if (!selectedTimestamp) {
			return;
		}
		if (selectedTimestamp == BACK) {
			await this.selectAndRestoreFolder(filesSrc, prefix);
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
			howToRestore == RESTORE_TO_RESTORE_FOLDER ? normalizePath(`${this.settings.restoreFolder}${this.sep}${selected}`) :
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
		this.app.workspace.onLayoutReady(() => this.onLayoutReady());

		this.addCommand({
			id: "find-from-backups",
			name: "Restore from backups",
			callback: async () => {
				await this.selectAndRestore();
			},
		})
		this.addCommand({
			id: "find-from-backups-dir",
			name: "Restore from backups per folder",
			callback: async () => {
				await this.selectAndRestoreFolder();
			},
		})
		this.addCommand({
			id: "create-diff-zip",
			name: "Create Differential Backup",
			callback: () => {
				this.createZip(true);
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

	async resetToC() {
		const toc = {} as FileInfos;
		const tocFilePath = await this.normalizePath(
			`${this.backupFolder}${this.sep}${InfoFile}`
		);
		// Update TOC
		if (await this.writeBinaryAuto(tocFilePath, new TextEncoder().encode(`\`\`\`\n${stringifyYaml(toc)}\n\`\`\`\n`))) {
			this.logMessage(`Backup information has been reset`);
		} else {
			this.logMessage(`Backup information cannot reset`);
		}
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
		containerEl.createEl("h2", { text: "General" });

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


		containerEl.createEl("h2", { text: "Backup Destination" });
		const dropDownRemote: Record<string, string> = {
			"": "Inside the vault",
			"desktop": "Anywhere (Desktop only)",
			"s3": "S3 Compatible Bucket"
		};
		if (this.plugin.isMobile) {
			delete dropDownRemote.desktop;
		}
		let backupDestination = this.plugin.settings.desktopFolderEnabled ? "desktop" : this.plugin.settings.bucketEnabled ? "s3" : "";
		new Setting(containerEl)
			.setName("Backup Destination")
			.setDesc("Select where to save the backup")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions(dropDownRemote)
					.setValue(backupDestination)
					.onChange(async (value) => {
						backupDestination = value;
						this.plugin.settings.desktopFolderEnabled = value == "desktop";
						this.plugin.settings.bucketEnabled = value == "s3";
						await this.plugin.saveSettings();
						this.display();
					})
			);

		if (backupDestination == "desktop") {
			// containerEl.createEl("p", { text: "You can save the backup outside of Obsidian. " });
			new Setting(containerEl)
				.setName("Backup folder (desktop)")
				.setDesc("We can use external folder of Obsidian only if on desktop and it is enabled. This feature uses Internal API.")
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
		} else if (backupDestination == "s3") {
			new Setting(containerEl)
				.setName("Endpoint")
				.setDesc("endPoint is a host name or an IP address")
				.addText(text => text
					.setPlaceholder('play.min.io')
					.setValue(this.plugin.settings.endPoint)
					.onChange(async (value) => {
						this.plugin.settings.endPoint = value;
						await this.plugin.saveSettings();
					}));
			new Setting(containerEl)
				.setName('AccessKey')
				.addText(text => text
					.setPlaceholder('Q3................2F')
					.setValue(this.plugin.settings.accessKey)
					.onChange(async (value) => {
						this.plugin.settings.accessKey = value;
						await this.plugin.saveSettings();
					}));
			new Setting(containerEl)
				.setName('SecretKey')
				.addText(text => text
					.setPlaceholder('zuf...................................TG')
					.setValue(this.plugin.settings.secretKey)
					.onChange(async (value) => {
						this.plugin.settings.secretKey = value;
						await this.plugin.saveSettings();
					}));
			new Setting(containerEl)
				.setName('Region')
				.addText(text => text
					.setPlaceholder('us-east-1')
					.setValue(this.plugin.settings.region)
					.onChange(async (value) => {
						this.plugin.settings.region = value;
						await this.plugin.saveSettings();
					}));
			new Setting(containerEl)
				.setName('Bucket')
				.addText(text => text
					.setValue(this.plugin.settings.bucket)
					.onChange(async (value) => {
						this.plugin.settings.bucket = value;
						await this.plugin.saveSettings();
					}));
			new Setting(containerEl)
				.setName("Use Custom HTTP Handler")
				.setDesc("If you are using a custom HTTP handler, enable this option.")
				.addToggle((toggle) =>
					toggle
						.setValue(this.plugin.settings.useCustomHttpHandler)
						.onChange(async (value) => {
							this.plugin.settings.useCustomHttpHandler = value;
							await this.plugin.saveSettings();
						})
				);
			new Setting(containerEl)
				.setName("Test and Initialise")
				.addButton((button) =>
					button.setButtonText("Test")
						.onClick(async () => {
							const client = await this.plugin.getClient();
							try {
								const buckets = await client.listBuckets();
								if (buckets.Buckets?.map(e => e.Name).indexOf(this.plugin.settings.bucket) !== -1) {
									new Notice("Connection is successful, and bucket is existing");
								} else {
									new Notice("Connection is successful, aut bucket is missing");
								}

							} catch (ex) {
								console.dir(ex);
								new Notice("Connection failed");
							}
						}))
				.addButton((button) =>
					button.setButtonText("Create Bucket")
						.onClick(async () => {
							const client = await this.plugin.getClient();
							try {
								await client.createBucket({
									Bucket: this.plugin.settings.bucket,
									CreateBucketConfiguration: {}
								});
								new Notice("Bucket has been created");
							} catch (ex) {
								new Notice(`Bucket creation failed\n-----\n${ex?.message ?? "Unknown error"}`);
								console.dir(ex);
							}
						}));
			new Setting(containerEl)
				.setName("Backup folder")
				.setDesc("Folder to keep each backup ZIPs and information file")
				.addText((text) =>
					text
						.setPlaceholder("backup")
						.setValue(this.plugin.settings.backupFolderBucket)
						.onChange(async (value) => {
							this.plugin.settings.backupFolderBucket = value;
							await this.plugin.saveSettings();
						})
				);
		} else {
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

		containerEl.createEl("h2", { text: "Restore" });

		new Setting(containerEl)
			.setName("Restore folder")
			.setDesc("Folder to save the restored file (Not applied on folder restore)")
			.addText((text) =>
				text
					.setPlaceholder("restored")
					.setValue(this.plugin.settings.restoreFolder)
					.onChange(async (value) => {
						this.plugin.settings.restoreFolder = value;
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl("h2", { text: "Backup ZIP Settings" });
		new Setting(containerEl)
			.setName("Max files in a single ZIP")
			.setDesc("(0 to disabled) Limit the number of files in a single ZIP file to better restore performance")
			.addText((text) =>
				text
					.setPlaceholder("100")
					.setValue(this.plugin.settings.maxFilesInZip + "")
					.onChange(async (value) => {
						this.plugin.settings.maxFilesInZip = Number.parseInt(value);
						await this.plugin.saveSettings();
					})
			);
		new Setting(containerEl)
			.setName("Perform all files over the max files")
			.setDesc("Automatically process the remaining files, even if the number of files to be processed exceeds Max files.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.performNextBackupOnMaxFiles)
					.onChange(async (value) => {
						this.plugin.settings.performNextBackupOnMaxFiles = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Max size of each output ZIP file")
			.setDesc("(MB) Size to split the backup zip file. Unzipping requires 7z or other compatible tools.")
			.addText((text) =>
				text
					.setPlaceholder("30")
					.setValue(this.plugin.settings.maxSize + "")
					.onChange(async (value) => {
						this.plugin.settings.maxSize = Number.parseInt(value);
						await this.plugin.saveSettings();
					})
			);


		containerEl.createEl("h2", { text: "Misc" });

		new Setting(containerEl)
			.setName("Reset Backup Information")
			.setDesc("After resetting, backup information will be lost.")
			.addButton((button) =>
				button.setWarning()
					.setButtonText("Reset")
					.onClick(async () => {
						this.plugin.resetToC();
					})
			);
		new Setting(containerEl)
			.setName("Encryption")
			.setDesc("Warning: This is not compatible with the usual ZIP tools. You can decrypt each file using OpenSSL with openssl  openssl enc -aes-256-cbc  -in [file]  -k [passphrase] -pbkdf2 -d -md sha256 > [out]")
			.addText((text) =>
				text
					.setPlaceholder("Passphrase")
					.setValue(this.plugin.settings.passphraseOfZip)
					.onChange(async (value) => {
						this.plugin.settings.passphraseOfZip = value;
						await this.plugin.saveSettings();
					}).inputEl.type = "password"
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
