import { normalizePath, TFile, TFolder, type Stat } from "obsidian";
import { StorageAccessor } from "./StorageAccessor.ts";
import { FileType, StorageAccessorTypes } from "./storage-contracts.ts";


export class NormalVault extends StorageAccessor {
    type = StorageAccessorTypes.NORMAL;

    sep = "/"; // Always use / as separator on vault.

    normalizePath(path: string): string {
        return normalizePath(path);
    }

    async createFolder(absolutePath: string): Promise<void> {
        await this.app.vault.createFolder(absolutePath);
    }

    async checkType(path: string): Promise<FileType> {
        await Promise.resolve();
        const af = this.app.vault.getAbstractFileByPath(path);
        if (af == null) return FileType.Missing;
        if (af instanceof TFile) return FileType.File;
        if (af instanceof TFolder) return FileType.Folder;
        throw new Error("Unknown file type.");
    }

    async _writeBinary(path: string, data: ArrayBuffer): Promise<boolean> {
        try {
            const af = this.app.vault.getAbstractFileByPath(path);
            if (af == null) {
                await this.app.vault.createBinary(path, data);
                return true;
            }
            if (af instanceof TFile) {
                await this.app.vault.modifyBinary(af, data);
                return true;
            }
        } catch (e) {
            console.error(e);
            return false;
        }
        throw new Error("Folder exists with the same name.");
    }

    async _readBinary(path: string) {
        if (!(await this.isFileExists(path))) return false;
        return this.app.vault.adapter.readBinary(path);
    }

    async deleteBinary(path: string): Promise<boolean> {
        try {
            const af = this.app.vault.getAbstractFileByPath(path);
            if (af == null) return true;
            if (af instanceof TFile) {
                await this.app.fileManager.trashFile(af);
                return true;
            }
            return false;
        } catch (e) {
            console.error(e);
            return false;
        }
    }

    async stat(path: string): Promise<false | Stat> {
        await Promise.resolve();
        const af = this.app.vault.getAbstractFileByPath(path);
        if (af == null) return false;
        if (af instanceof TFile) {
            return {
                type: "file",
                mtime: af.stat.mtime,
                size: af.stat.size,
                ctime: af.stat.ctime,
            };
        } else if (af instanceof TFolder) {
            return {
                type: "folder",
                mtime: 0,
                ctime: 0,
                size: 0,
            };
        }
        throw new Error("Unknown file type.");
    }
}
