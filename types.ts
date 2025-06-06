import type { Notice } from "obsidian";

export enum AutoBackupType {
    FULL = "",
    ONLY_NEW = "only-new",
    ONLY_NEW_AND_EXISTING = "only-new-and-existing",
}
export const InfoFile = `backupinfo.md`;
export interface DiffZipBackupSettings {
    backupFolder?: string;
    backupFolderMobile: string;
    backupFolderBucket: string;
    restoreFolder: string;
    maxSize: number;
    maxFilesInZip: number;
    performNextBackupOnMaxFiles: boolean;
    startBackupAtLaunch: boolean;
    startBackupAtLaunchType: AutoBackupType;
    includeHiddenFolder: boolean;
    desktopFolderEnabled: boolean;
    BackupFolderDesktop: string;
    bucketEnabled: boolean;

    endPoint: string;
    accessKey: string;
    secretKey: string;
    bucket: string;
    region: string;
    passphraseOfFiles: string;
    passphraseOfZip: string;
    useCustomHttpHandler: boolean;
}
export const DEFAULT_SETTINGS: DiffZipBackupSettings = {
    startBackupAtLaunch: false,
    startBackupAtLaunchType: AutoBackupType.ONLY_NEW_AND_EXISTING,
    backupFolderMobile: "backup",
    BackupFolderDesktop: "c:\\temp\\backup",
    backupFolderBucket: "backup",
    restoreFolder: "restored",
    includeHiddenFolder: false,
    maxSize: 30,
    desktopFolderEnabled: false,
    bucketEnabled: false,
    endPoint: "",
    accessKey: "",
    secretKey: "",
    region: "",
    bucket: "diffzip",
    maxFilesInZip: 100,
    performNextBackupOnMaxFiles: true,
    useCustomHttpHandler: false,
    passphraseOfFiles: "",
    passphraseOfZip: "",
};
export type FileInfo = {
    filename: string;
    digest: string;
    history: { zipName: string; modified: string; missing?: boolean; processed?: number; digest: string }[];
    mtime: number;
    processed?: number;
    missing?: boolean;
};
export type FileInfos = Record<string, FileInfo>;
export type NoticeWithTimer = {
    notice: Notice;
    timer?: ReturnType<typeof setTimeout>;
};
