import type { App } from "obsidian";
import type { DiffZipBackupSettings } from "../types.ts";

/** Minimal plug-in boundary required by storage accessor implementations. */
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
