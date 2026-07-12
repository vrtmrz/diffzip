import type { Stat } from "obsidian";
import { OpenSSLCompat } from "octagonal-wheels/encryption";
import {
    type StorageAccessorHost,
    type StorageAccessorType,
    FileType,
} from "./storage-contracts.ts";
import { toArrayBuffer } from "../util.ts";

const decryptCompatOpenSSL = OpenSSLCompat.CBC.decryptCBC;
const encryptCompatOpenSSL = OpenSSLCompat.CBC.encryptCBC;

export abstract class StorageAccessor {
    abstract type: StorageAccessorType;
    abstract sep: string;
    public plugin: StorageAccessorHost;
    get app() {
        return this.plugin.app;
    }
    get settings() {
        return this.plugin.settings;
    }
    public basePath: string;
    get rootPath() {
        if (this.basePath == "") return "";
        return this.basePath + this.sep;
    }
    public isLocal: boolean = false;

    constructor(plugin: StorageAccessorHost, basePath?: string, isLocal?: boolean) {
        this.basePath = basePath || "";
        this.plugin = plugin;
        this.isLocal = isLocal || false;
    }

    abstract createFolder(absolutePath: string): Promise<void>;
    abstract checkType(path: string): Promise<FileType>;

    async isFolderExists(path: string): Promise<boolean> {
        return (await this.checkType(path)) == FileType.Folder;
    }
    async isFileExists(path: string): Promise<boolean> {
        return (await this.checkType(path)) == FileType.File;
    }
    async isExists(path: string): Promise<boolean> {
        return (await this.checkType(path)) != FileType.Missing;
    }

    async readBinary(path: string, preventUseCache = false): Promise<ArrayBuffer | false> {
        const encryptedData = await this._readBinary(path, preventUseCache);
        if (encryptedData === false) return false;
        if (!this.isLocal && this.settings.passphraseOfZip) {
            return toArrayBuffer(await decryptCompatOpenSSL(new Uint8Array(encryptedData), this.settings.passphraseOfZip, 10000));
        }
        return encryptedData;
    }

    async readTOC(path: string): Promise<ArrayBuffer | false> {
        if (this.type != "normal") return await this.readBinary(path, true);
        return await this._readBinary(path, true);
    }

    async writeBinary(path: string, data: ArrayBuffer): Promise<boolean> {
        let content = data;
        if (!this.isLocal && this.settings.passphraseOfZip) {
            content = toArrayBuffer(await encryptCompatOpenSSL(new Uint8Array(data), this.settings.passphraseOfZip, 10000));
        }
        await this.ensureDirectory(path);
        return await this._writeBinary(path, content);
    }

    async writeTOC(path: string, data: ArrayBuffer): Promise<boolean> {
        if (this.type != "normal") return this.writeBinary(path, data);
        await this.ensureDirectory(path);
        return await this._writeBinary(path, data);
    }

    abstract _writeBinary(path: string, data: ArrayBuffer): Promise<boolean>;
    abstract _readBinary(path: string, preventUseCache?: boolean): Promise<ArrayBuffer | false>;
    abstract deleteBinary(path: string): Promise<boolean>;

    abstract normalizePath(path: string): string;
    abstract stat(path: string): Promise<false | Stat>;

    async ensureDirectory(fullPath: string) {
        const pathElements = (this.rootPath + fullPath).split(this.sep);
        pathElements.pop();
        let c = "";
        for (const v of pathElements) {
            c += v;
            const type = await this.checkType(c);
            if (type == FileType.File) {
                throw new Error("File exists with the same name.");
            } else if (type == FileType.Missing) {
                await this.createFolder(c);
            }
            c += this.sep;
        }
    }
}
