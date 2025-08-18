/**
 * Abstract class for storage accessors and its implementations.
 */
import type DiffZipBackupPlugin from "../main.ts";
import type { promises } from "node:fs";
import { OpenSSLCompat } from "octagonal-wheels/encryption";
import { NormalVault } from "./StorageAccessor/NormalVault.ts";
import { DirectVault } from "./StorageAccessor/DirectVault.ts";
import { ExternalVaultFilesystem } from "./StorageAccessor/ExternalVaultFilesystem.ts";
import { S3Bucket } from "./StorageAccessor/S3Bucket.ts";
import { StorageAccessor } from "./StorageAccessor/StorageAccessor.ts";
export const decryptCompatOpenSSL = OpenSSLCompat.CBC.decryptCBC;
export const encryptCompatOpenSSL = OpenSSLCompat.CBC.encryptCBC;

export enum FileType {
    "Missing",
    "File",
    "Folder",
}

export type FsAPI = {
    mkdir: typeof promises.mkdir;
    writeFile: typeof promises.writeFile;
    readFile: typeof promises.readFile;
    stat: typeof promises.stat;
};

export const StorageAccessorTypes = {
    NORMAL: "normal",
    DIRECT: "direct",
    EXTERNAL: "external",
    S3: "s3",
} as const;

export type StorageAccessorType = typeof StorageAccessorTypes[keyof typeof StorageAccessorTypes];

export function getStorageTypeForBackupAccess(plugin: DiffZipBackupPlugin): StorageAccessorType {
    if (plugin.isDesktopMode) {
        return StorageAccessorTypes.EXTERNAL;
    } else if (plugin.settings.bucketEnabled) {
        return StorageAccessorTypes.S3;
    } else {
        return StorageAccessorTypes.DIRECT;
    }
}
export function getStorageTypeForVaultAccess(plugin: DiffZipBackupPlugin): StorageAccessorType {
    if (plugin.settings.includeHiddenFolder) {
        return StorageAccessorTypes.DIRECT;
    }
    return StorageAccessorTypes.NORMAL;
}

export function getStorageInstance(
    type: StorageAccessorType,
    plugin: DiffZipBackupPlugin,
    basePath?: string,
    isLocal?: boolean
): StorageAccessor {
    if (type == StorageAccessorTypes.EXTERNAL) {
        return new ExternalVaultFilesystem(plugin, basePath, isLocal);
    } else if (type == StorageAccessorTypes.S3) {
        return new S3Bucket(plugin, basePath, isLocal);
    } else if (type == StorageAccessorTypes.DIRECT) {
        return new DirectVault(plugin, basePath, isLocal);
    } else {
        return new NormalVault(plugin, basePath, isLocal);
    }
}

export function getStorageForVault(plugin: DiffZipBackupPlugin, basePath?: string): StorageAccessor {
    const type = getStorageTypeForVaultAccess(plugin);
    return getStorageInstance(type, plugin, basePath, true);
}
export function getStorageForBackup(plugin: DiffZipBackupPlugin, basePath?: string, isLocal?: boolean): StorageAccessor {
    const type = getStorageTypeForBackupAccess(plugin);
    return getStorageInstance(type, plugin, basePath, isLocal);
}
