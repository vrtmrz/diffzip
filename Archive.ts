import * as fflate from "fflate";
import { promiseWithResolver } from "octagonal-wheels/promises";

/**
 * A class to archive files
 */
export class Archiver {
	_zipFile: fflate.Zip;

	_aborted: boolean = false;
	_output: Uint8Array[] = [];

	_processedCount: number = 0;
	_processedLength: number = 0;
	_archivedCount: number = 0;
	_archiveSize: number = 0;


	progressReport(type: string) {
		// console.warn(
		// 	`Archiver: ${type} processed: ${this._processedCount} (${this._processedLength} bytes) ${this._archivedCount} (${this._archiveSize} bytes)`
		// )
	}

	_zipFilePromise = promiseWithResolver<Uint8Array>();
	get archivedZipFile(): Promise<Uint8Array> {
		return this._zipFilePromise.promise;
	}

	get currentSize(): number {
		return this._output.reduce((acc, val) => acc + val.length, 0);
	}

	constructor() {
		// this._archiveName = archiveName;
		const zipFile = new fflate.Zip(async (error, dat, final) => this._onProgress(
			error, dat, final
		));
		this._zipFile = zipFile;
	}

	_onProgress(err: fflate.FlateError | null, data: Uint8Array, final: boolean) {
		if (err) {
			return this._onError(err);
		}
		if (data && data.length > 0) {
			this._output.push(data);
			this._archiveSize += data.length;
		}
		// No error
		this.progressReport("progress");
		if (this._aborted) {
			return this._onAborted();
		}
		if (final) {
			void this._onFinalise();
		}
	}

	async _onFinalise(): Promise<void> {
		this._zipFile.terminate();
		const out = new Blob(this._output, { type: "application/zip" });
		const result = new Uint8Array(await out.arrayBuffer());
		this._zipFilePromise.resolve(result);
	}

	_onAborted() {
		this._zipFile.terminate();
		this._zipFilePromise.reject(new Error("Aborted"));
	}
	_onError(err: fflate.FlateError): void {
		this._zipFile.terminate();
		this._zipFilePromise.reject(err);
	}

	addTextFile(text: string, path: string, options?: { mtime?: number }): void {
		const binary = new TextEncoder().encode(text);
		this.addFile(binary, path, options);
	}

	addFile(file: Uint8Array, path: string, options?: { mtime?: number }): void {
		const fflateFile = new fflate.ZipDeflate(path, {
			level: 9,
		});
		if (options?.mtime) {
			fflateFile.mtime = options.mtime;
		} else {
			fflateFile.mtime = Date.now();
		}
		this._processedLength += file.length;
		this.progressReport("add");
		this._zipFile.add(fflateFile);

		// TODO: Check if the large file can be added in a single chunks
		fflateFile.push(file, true);
	}

	finalize() {
		this._zipFile.end();
		return this.archivedZipFile;
	}




}

/**
 * A class to extract files from a zip archive
 */
export class Extractor {
	_zipFile: fflate.Unzip;
	_isFileShouldBeExtracted: (file: fflate.UnzipFile) => boolean | Promise<boolean>;
	_onExtracted: (filename: string, content: Uint8Array) => Promise<void>;
	constructor(isFileShouldBeExtracted: typeof this["_isFileShouldBeExtracted"], callback: typeof this["_onExtracted"],) {
		const unzipper = new fflate.Unzip();
		unzipper.register(fflate.UnzipInflate);
		this._zipFile = unzipper;
		this._isFileShouldBeExtracted = isFileShouldBeExtracted;
		this._onExtracted = callback;
		unzipper.onfile = async (file: fflate.UnzipFile) => {
			if (await this._isFileShouldBeExtracted(file)) {
				const data: Uint8Array[] = [];
				file.ondata = async (err, dat, isFinal) => {
					if (err) {
						console.error("Error extracting file", err);
						return;
					}
					if (dat && dat.length > 0) {
						data.push(dat);
					}

					if (isFinal) {
						const total = new Blob(data, { type: "application/octet-stream" });
						const result = new Uint8Array(await total.arrayBuffer());
						await this._onExtracted(file.name, result);
					}
				}
				file.start();
			} else {
				// Skip the file
			}
		}
	}
	addZippedContent(data: Uint8Array, isFinal = false) {
		this._zipFile.push(data, isFinal);
	}
	finalise() {
		this._zipFile.push(new Uint8Array(), true);
	}
}
