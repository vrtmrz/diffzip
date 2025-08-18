import type { Stat } from "obsidian";
import { type FsAPI, FileType, StorageAccessorTypes } from "../storage.ts";
import { StorageAccessor } from "./StorageAccessor.ts";
import { toArrayBuffer } from "../util.ts";


export class ExternalVaultFilesystem extends StorageAccessor {
    type = StorageAccessorTypes.EXTERNAL;

    get sep(): string {
        //@ts-ignore internal API
        return this.app.vault.adapter.path.sep;
    }
    get fsPromises(): FsAPI {
        //@ts-ignore internal API
        return this.app.vault.adapter.fsPromises;
    }

    async createFolder(absolutePath: string): Promise<void> {
        await this.fsPromises.mkdir(absolutePath, { recursive: true });
    }

    async ensureDirectory(fullPath: string) {
        const delimiter = this.sep;
        const pathElements = fullPath.split(delimiter);
        pathElements.pop();
        const mkPath = pathElements.join(delimiter);
        return await this.createFolder(mkPath);
    }

    async _writeBinary(fullPath: string, data: ArrayBuffer) {
        try {
            await this.fsPromises.writeFile(fullPath, Buffer.from(data));
            return true;
        } catch (e) {
            console.error(e);
            return false;
        }
    }

    async _readBinary(path: string): Promise<ArrayBuffer | false> {
        const buffer = await this.fsPromises.readFile(path) as Buffer<ArrayBuffer>;
        return toArrayBuffer(buffer.buffer)
    }

    async checkType(path: string): Promise<FileType> {
        try {
            const stat = await this.fsPromises.stat(path);
            if (stat.isDirectory()) return FileType.Folder;
            if (stat.isFile()) return FileType.File;
            // If it is not file or folder, then it is missing.
            // This is not possible in normal cases.
            return FileType.Missing;
        } catch {
            return FileType.Missing;
        }
    }

    normalizePath(path: string): string {
        //@ts-ignore internal API
        const f = this.app.vault.adapter.path;
        //@ts-ignore internal API
        const basePath = this.app.vault.adapter.basePath;
        const normalizedPath = f.normalize(path);
        const result = f.resolve(basePath, normalizedPath);
        return result;
    }

    async stat(path: string): Promise<false | Stat> {
        //
        // It is not used on external vault for `backup` accessing. If we want to use this for vaultAccess, uncomment and test this.
        //
        // const nPath = this.normalizePath(path);
        // const stat = await this.fsPromises.stat(nPath).catch(() => false as false);
        // if (!stat) return false;
        // return {
        //     type: stat.isDirectory() ? "folder" : "file",
        //     mtime: stat.mtime.getTime(),
        //     ctime: stat.ctime.getTime(),
        //     size: stat.size,
        // };
        throw new Error("Unsupported operation.");
    }
}
