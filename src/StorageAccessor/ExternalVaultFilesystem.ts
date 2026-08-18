import type { Stat } from "obsidian";
import { StorageAccessor } from "./StorageAccessor.ts";
import { FileType, StorageAccessorTypes } from "./storage-accessor-types.ts";
import { toArrayBuffer } from "../util.ts";

type DesktopPathAPI = {
    sep: string;
    normalize: (path: string) => string;
    resolve: (...paths: string[]) => string;
};

type DesktopFileStat = {
    isDirectory: () => boolean;
    isFile: () => boolean;
};

type FsAPI = {
    mkdir: (path: string, options: { recursive: true }) => Promise<unknown>;
    writeFile: (path: string, data: Uint8Array<ArrayBuffer>) => Promise<unknown>;
    readFile: (path: string) => Promise<Uint8Array<ArrayBufferLike>>;
    stat: (path: string) => Promise<DesktopFileStat>;
    rm: (path: string, options: { force: true }) => Promise<unknown>;
};

type DesktopFileSystemAdapter = {
    path: DesktopPathAPI;
    basePath: string;
    fsPromises: FsAPI;
};

export class ExternalVaultFilesystem extends StorageAccessor {
    type = StorageAccessorTypes.EXTERNAL;

    private get desktopAdapter(): DesktopFileSystemAdapter {
        return this.app.vault.adapter as unknown as DesktopFileSystemAdapter;
    }

    get sep(): string {
        return this.desktopAdapter.path.sep;
    }
    get fsPromises(): FsAPI {
        return this.desktopAdapter.fsPromises;
    }

    async createFolder(absolutePath: string): Promise<void> {
        await this.fsPromises.mkdir(absolutePath, { recursive: true });
    }

    override async ensureDirectory(fullPath: string) {
        const delimiter = this.sep;
        const pathElements = fullPath.split(delimiter);
        pathElements.pop();
        const mkPath = pathElements.join(delimiter);
        return await this.createFolder(mkPath);
    }

    async _writeBinary(fullPath: string, data: ArrayBuffer) {
        try {
            await this.fsPromises.writeFile(fullPath, new Uint8Array(data));
            return true;
        } catch {
            return false;
        }
    }

    async _readBinary(path: string): Promise<ArrayBuffer | false> {
        const buffer = await this.fsPromises.readFile(path);
        return toArrayBuffer(buffer);
    }

    async deleteBinary(path: string): Promise<boolean> {
        try {
            await this.fsPromises.rm(path, { force: true });
            return true;
        } catch {
            return false;
        }
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
        const { path: f, basePath } = this.desktopAdapter;
        const normalizedPath = f.normalize(path);
        return f.resolve(basePath, normalizedPath);
    }

    async stat(_path: string): Promise<false | Stat> {
        await Promise.resolve();
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
