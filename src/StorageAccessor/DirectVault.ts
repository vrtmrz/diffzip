import type { Stat } from "obsidian";
import { FileType, StorageAccessorTypes } from "../storage.ts";
import { StorageAccessor } from "./StorageAccessor.ts";


export class DirectVault extends StorageAccessor {
    type = StorageAccessorTypes.DIRECT;

    sep = "/"; // Always use / as separator on vault.

    async createFolder(absolutePath: string): Promise<void> {
        await this.app.vault.adapter.mkdir(absolutePath);
    }

    async checkType(path: string): Promise<FileType> {
        const existence = await this.app.vault.adapter.exists(path);
        if (!existence) return FileType.Missing;
        const stat = await this.app.vault.adapter.stat(path);
        if (stat && stat.type == "folder") return FileType.Folder;
        return FileType.File;
    }

    async _writeBinary(path: string, data: ArrayBuffer): Promise<boolean> {
        try {
            await this.app.vault.adapter.writeBinary(path, data);
            return true;
        } catch (e) {
            console.error(e);
            return false;
        }
    }

    async _readBinary(path: string) {
        if (!(await this.isFileExists(path))) return false;
        return this.app.vault.adapter.readBinary(path);
    }

    async deleteBinary(path: string): Promise<boolean> {
        try {
            if (!(await this.isFileExists(path))) return true;
            await this.app.vault.adapter.remove(path);
            return true;
        } catch (e) {
            console.error(e);
            return false;
        }
    }

    async stat(path: string): Promise<false | Stat> {
        const stat = await this.app.vault.adapter.stat(path);
        if (!stat) return false;
        return stat;
    }
}
