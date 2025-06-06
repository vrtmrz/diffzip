/**
 * Abstract class for storage accessors and its implementations.
 */
import type DiffZipBackupPlugin from "./main";
import { S3 } from "@aws-sdk/client-s3";
import { ObsHttpHandler } from "./ObsHttpHandler";
import type { promises } from "node:fs";
import { normalizePath, TFile, TFolder, type Stat } from "obsidian";
import { OpenSSLCompat } from "octagonal-wheels/encryption";
const decryptCompatOpenSSL = OpenSSLCompat.CBC.decryptCBC;
const encryptCompatOpenSSL = OpenSSLCompat.CBC.encryptCBC;

export enum FileType {
    "Missing",
    "File",
    "Folder",
}

type FsAPI = {
    mkdir: typeof promises.mkdir;
    writeFile: typeof promises.writeFile;
    readFile: typeof promises.readFile;
    stat: typeof promises.stat;
};

export type StorageAccessorType = "normal" | "direct" | "external" | "s3";

export abstract class StorageAccessor {
    type: StorageAccessorType;
    abstract sep: string;
    public plugin: DiffZipBackupPlugin;
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

    constructor(plugin: DiffZipBackupPlugin, basePath?: string, isLocal?: boolean) {
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

    async readBinary(path: string): Promise<ArrayBuffer | false> {
        const encryptedData = await this._readBinary(path);
        if (encryptedData === false) return false;
        if (!this.isLocal && this.settings.passphraseOfZip) {
            return await decryptCompatOpenSSL(new Uint8Array(encryptedData), this.settings.passphraseOfZip, 10000);
        }
        return encryptedData;
    }

    async readTOC(path: string): Promise<ArrayBuffer | false> {
        if (this.type != "normal") return await this.readBinary(path);
        return await this._readBinary(path, true);
    }

    async writeBinary(path: string, data: ArrayBuffer): Promise<boolean> {
        let content = data;
        if (!this.isLocal && this.settings.passphraseOfZip) {
            content = await encryptCompatOpenSSL(new Uint8Array(data), this.settings.passphraseOfZip, 10000);
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

    normalizePath(path: string): string {
        return normalizePath(path);
    }
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

export class NormalVault extends StorageAccessor {
    type = "normal" as const;

    sep = "/"; // Always use / as separator on vault.

    async createFolder(absolutePath: string): Promise<void> {
        await this.app.vault.createFolder(absolutePath);
    }

    async checkType(path: string): Promise<FileType> {
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

    async stat(path: string): Promise<false | Stat> {
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

export class DirectVault extends StorageAccessor {
    type = "direct" as const;

    // constructor(plugin: DiffZipBackupPlugin, basePath?: string) {
    // 	super(plugin, basePath);
    // }
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

    async stat(path: string): Promise<false | Stat> {
        const stat = await this.app.vault.adapter.stat(path);
        if (!stat) return false;
        return stat;
    }
}

export class ExternalVaultFilesystem extends StorageAccessor {
    type = "external" as const;

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
        return (await this.fsPromises.readFile(path)).buffer;
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
        return f.normalize(path);
    }

    stat(path: string): Promise<false | Stat> {
        throw new Error("Unsupported operation.");
    }
}

export class S3Bucket extends StorageAccessor {
    type = "s3" as const;
    sep = "/";

    createFolder(absolutePath: string): Promise<void> {
        // S3 does not have folder concept. So, we don't need to create folder.
        return Promise.resolve();
    }
    ensureDirectory(fullPath: string): Promise<void> {
        return Promise.resolve();
    }

    async checkType(path: string): Promise<FileType> {
        const client = await this.getClient();
        try {
            await client.headObject({
                Bucket: this.settings.bucket,
                Key: path,
            });
            return FileType.File;
        } catch {
            return FileType.Missing;
        }
    }

    async getClient() {
        const client = new S3({
            endpoint: this.settings.endPoint,
            region: this.settings.region,
            forcePathStyle: true,
            credentials: {
                accessKeyId: this.settings.accessKey,
                secretAccessKey: this.settings.secretKey,
            },
            requestHandler: this.settings.useCustomHttpHandler ? new ObsHttpHandler(undefined, undefined) : undefined,
        });
        return client;
    }

    async _writeBinary(fullPath: string, data: ArrayBuffer) {
        const client = await this.getClient();
        try {
            const r = await client.putObject({
                Bucket: this.settings.bucket,
                Key: fullPath,
                Body: new Uint8Array(data),
            });
            if (~~((r.$metadata.httpStatusCode ?? 500) / 100) == 2) {
                return true;
            } else {
                console.error(`Failed to write binary to ${fullPath} (response code:${r.$metadata.httpStatusCode}).`);
            }
            return false;
        } catch (e) {
            console.error(e);
            return false;
        }
    }

    async _readBinary(fullPath: string, preventCache = false) {
        const client = await this.getClient();
        const result = await client.getObject({
            Bucket: this.settings.bucket,
            Key: fullPath,
            IfNoneMatch: preventCache ? "*" : undefined,
        });
        if (!result.Body) return false;
        return await result.Body.transformToByteArray();
    }

    stat(path: string): Promise<false | Stat> {
        throw new Error("Unsupported operation.");
    }
}

export function getStorageType(plugin: DiffZipBackupPlugin): StorageAccessorType {
    if (plugin.isDesktopMode) {
        return "external";
    } else if (plugin.settings.bucketEnabled) {
        return "s3";
    } else {
        return "normal";
    }
}

export function getStorageInstance(
    type: StorageAccessorType,
    plugin: DiffZipBackupPlugin,
    basePath?: string,
    isLocal?: boolean
): StorageAccessor {
    if (type == "external") {
        return new ExternalVaultFilesystem(plugin, basePath, isLocal);
    } else if (type == "s3") {
        return new S3Bucket(plugin, basePath, isLocal);
    } else if (type == "direct") {
        return new DirectVault(plugin, basePath, isLocal);
    } else {
        return new NormalVault(plugin, basePath, isLocal);
    }
}

export function getStorage(plugin: DiffZipBackupPlugin, basePath?: string, isLocal?: boolean): StorageAccessor {
    const type = getStorageType(plugin);
    return getStorageInstance(type, plugin, basePath, isLocal);
}
