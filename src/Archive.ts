import * as fflate from "fflate";
import { promiseWithResolvers, type PromiseWithResolvers } from "octagonal-wheels/promises";
import type { XByteArray } from "./types.ts";

/**
 * A class to archive files
 */
export class Archiver {
    _zipFile: fflate.Zip;
    _aborted: boolean = false;
    _output: XByteArray[] = [];
    _processedCount: number = 0;
    _processedLength: number = 0;
    _archivedCount: number = 0;
    _archiveSize: number = 0;

    progressReport(type: string) {
        // console.warn(
        // 	`Archiver: ${type} processed: ${this._processedCount} (${this._processedLength} bytes) ${this._archivedCount} (${this._archiveSize} bytes)`
        // )
    }

    _zipFilePromise: PromiseWithResolvers<XByteArray> = promiseWithResolvers<XByteArray>();
    get archivedZipFile(): Promise<XByteArray> {
        return this._zipFilePromise.promise;
    }

    get currentSize(): number {
        return this._output.reduce((acc, val) => acc + val.length, 0);
    }

    constructor() {
        const zipFile = new fflate.Zip((error, dat: Uint8Array<ArrayBufferLike>, final) => this._onProgress(error, dat, final));
        this._zipFile = zipFile;
    }

    _onProgress(err: fflate.FlateError | null, data: Uint8Array<ArrayBufferLike>, final: boolean) {
        if (err) return this._onError(err);
        if (data && data.length > 0) {
            this._output.push(new Uint8Array(data));
            this._archiveSize += data.length;
        }
        // No error
        this.progressReport("progress");
        if (this._aborted) return this._onAborted();
        if (final) void this._onFinalise();
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

    addFileTask = Promise.resolve();
    addFile(file: XByteArray, path: string, options?: { mtime?: number }, progress?: (processed: number, total: number, finished: boolean) => void): void {
        const fflateFile = new fflate.ZipDeflate(path, { level: 9 });
        fflateFile.mtime = options?.mtime ?? Date.now();
        const total = file.byteLength;
        let processed = 0;
        this.progressReport("add");
        this._zipFile.add(fflateFile);
        const MAX_CHUNK_SIZE = 1024 * 1024; // 1MB
        const MIN_CHUNK_SIZE = 64 * 1024; // 64KB
        const div10 = Math.ceil(file.length / 10);
        const chunkSize = Math.max(Math.min(MAX_CHUNK_SIZE, div10), MIN_CHUNK_SIZE);
        this.addFileTask = this.addFileTask.then(async () => {
            for (let i = 0; i < file.length; i += chunkSize) {
                const chunk = file.slice(i, i + chunkSize);
                processed += chunk.byteLength;
                fflateFile.push(chunk, false);
                if (chunkSize > MIN_CHUNK_SIZE) {
                    progress?.(processed, total, false);
                }
                await new Promise(res => window.setTimeout(res, 1));
            }
            fflateFile.push(new Uint8Array(), true);
            progress?.(processed, total, true);
            return Promise.resolve();
        });
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
    _onExtracted: (filename: string, content: XByteArray) => Promise<void>;

    constructor(isFileShouldBeExtracted: Extractor["_isFileShouldBeExtracted"], callback: Extractor["_onExtracted"]) {
        const unzipper = new fflate.Unzip();
        unzipper.register(fflate.UnzipInflate);
        this._zipFile = unzipper;
        this._isFileShouldBeExtracted = isFileShouldBeExtracted;
        this._onExtracted = callback;

        const onFile = async (file: fflate.UnzipFile) => {
            if (await this._isFileShouldBeExtracted(file)) {
                const data: XByteArray[] = [];
                const onData = async (err: fflate.FlateError | null, dat: Uint8Array, isFinal: boolean) => {
                    if (err) {
                        console.error("Error extracting file", err);
                        return;
                    }
                    if (dat && dat.length > 0) data.push(new Uint8Array(dat));

                    if (isFinal) {
                        const total = new Blob(data, { type: "application/octet-stream" });
                        const result = new Uint8Array(await total.arrayBuffer());
                        await this._onExtracted(file.name, result);
                    }
                };
                file.ondata = (err, dat, isFinal) => void onData(err, dat, isFinal);
                file.start();
            }
        };
        unzipper.onfile = (file) => void onFile(file);
    }

    addZippedContent(data: XByteArray, isFinal = false) {
        this._zipFile.push(data, isFinal);
    }

    finalise() {
        this._zipFile.push(new Uint8Array(), true);
    }
}
