import type { App } from "obsidian";
import type { DiffZipBackupSettings } from "../types.ts";

/**
 * DiffZip-owned context supplied to storage accessor implementations.
 *
 * This is an internal composition shape, not a platform-neutral storage contract.
 */
export interface StorageAccessorHost {
    readonly app: App;
    readonly settings: DiffZipBackupSettings;
}

/** File kind reported by a storage accessor. */
export enum FileType {
    Missing,
    File,
    Folder,
}

/** Stable storage accessor identifiers. */
export const StorageAccessorTypes = {
    NORMAL: "normal",
    DIRECT: "direct",
    EXTERNAL: "external",
    S3: "s3",
} as const;

/** Identifier for one DiffZip storage accessor implementation. */
export type StorageAccessorType = typeof StorageAccessorTypes[keyof typeof StorageAccessorTypes];
