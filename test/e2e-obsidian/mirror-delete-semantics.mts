import { withObsidianPage } from "@vrtmrz/obsidian-test-session";
import type { Page } from "playwright";
import {
    DELETE_BEFORE_RECREATE_PATH,
    DELETE_BEFORE_RECREATE_TIMESTAMP,
    DIFFZIP_PLUGIN_ID,
    EXTRACTION_PROBE_PATH,
    EXTRACTION_PROBE_ZIP,
    FAILED_RESTORE_DELETION_PATH,
    MIRROR_DELETION_FIXTURE_PATHS,
    NORMAL_BEFORE_DELETE_PATH,
    NORMAL_BEFORE_DELETE_TIMESTAMP,
    startDiffZipTestSession,
    stopDiffZipTestSession,
    type DiffZipTestSession,
} from "./harness.mts";

interface RestoreModeEvidence {
    deleteMissing: boolean;
    onlyNew: boolean;
}

interface DeleteExecutionEvidence {
    deletionCandidateStillExists: boolean;
    deletionCandidateWasExtracted: boolean;
}

interface RevisionEvidence {
    activeLeasesAtConfirmation: number;
    activeLeaseCounts: number[];
    activeLeasesAfter: number;
    deleted: string[];
    extracted: string[];
}

interface FailureEvidence {
    failedRestoreRejected: boolean;
    deletionCandidateStillExists: boolean;
    missingArchiveRejected: boolean;
    missingEntryRejected: boolean;
    readFailureRejected: boolean;
    writeFailureRejected: boolean;
}

async function executeCommand(page: Page, commandId: string): Promise<void> {
    const executed = await page.evaluate((id) => {
        const obsidianApp = (
            globalThis as typeof globalThis & {
                app?: { commands?: { executeCommandById(commandId: string): boolean } };
            }
        ).app;
        return obsidianApp?.commands?.executeCommandById(id) ?? false;
    }, commandId);
    if (!executed) throw new Error(`Command was unavailable: ${commandId}`);
}

async function observeAllDeleteMode(page: Page): Promise<RestoreModeEvidence> {
    await page.evaluate((pluginId) => {
        interface RestorePlugin {
            restoreVault(
                onlyNew?: boolean,
                deleteMissing?: boolean,
                fileFilter?: Record<string, number>,
                prefix?: string
            ): Promise<void>;
        }
        const root = globalThis as typeof globalThis & {
            app?: { plugins?: { plugins?: Record<string, RestorePlugin> } };
            diffzipMirrorModeEvidence?: RestoreModeEvidence;
            diffzipOriginalRestoreVault?: RestorePlugin["restoreVault"];
        };
        const plugin = root.app?.plugins?.plugins?.[pluginId];
        if (!plugin) throw new Error(`DiffZip is not loaded: ${pluginId}`);
        root.diffzipOriginalRestoreVault = plugin.restoreVault;
        plugin.restoreVault = async (onlyNew = true, deleteMissing = false) => {
            root.diffzipMirrorModeEvidence = { onlyNew, deleteMissing };
        };
    }, DIFFZIP_PLUGIN_ID);

    try {
        await executeCommand(page, `${DIFFZIP_PLUGIN_ID}:a-find-from-backups`);
        const modal = page.locator(".modal-container").last();
        await modal.getByLabel("Restore Mode").waitFor({ state: "visible", timeout: 10_000 });
        await modal.getByRole("button", { name: "Select All Latest", exact: true }).click();
        await modal.getByLabel("Restore Mode").selectOption("all-delete");
        await modal.getByRole("button", { name: "Restore", exact: true }).click();
        await modal.waitFor({ state: "detached", timeout: 10_000 });
        return await page.evaluate(() => {
            const evidence = (globalThis as typeof globalThis & { diffzipMirrorModeEvidence?: RestoreModeEvidence })
                .diffzipMirrorModeEvidence;
            if (!evidence) throw new Error("Restore mode evidence was not captured");
            return evidence;
        });
    } finally {
        await page.evaluate((pluginId) => {
            interface RestorePlugin {
                restoreVault(
                    onlyNew?: boolean,
                    deleteMissing?: boolean,
                    fileFilter?: Record<string, number>,
                    prefix?: string
                ): Promise<void>;
            }
            const root = globalThis as typeof globalThis & {
                app?: { plugins?: { plugins?: Record<string, RestorePlugin> } };
                diffzipOriginalRestoreVault?: RestorePlugin["restoreVault"];
            };
            const plugin = root.app?.plugins?.plugins?.[pluginId];
            if (plugin && root.diffzipOriginalRestoreVault) {
                plugin.restoreVault = root.diffzipOriginalRestoreVault;
            }
            delete root.diffzipOriginalRestoreVault;
            delete (root as typeof root & { diffzipMirrorModeEvidence?: RestoreModeEvidence })
                .diffzipMirrorModeEvidence;
        }, DIFFZIP_PLUGIN_ID);
    }
}

async function observeDeleteExecution(page: Page): Promise<DeleteExecutionEvidence> {
    await page.evaluate(
        ({ pluginId, paths }) => {
            interface RestorePlugin {
                extractWithoutWakeLock(
                    zipName: string,
                    files: string | string[],
                    restoreAs?: string,
                    prefix?: string
                ): Promise<void>;
                restoreVault(onlyNew?: boolean, deleteMissing?: boolean): Promise<void>;
                vaultAccess: { stat(path: string): Promise<unknown> };
            }
            const root = globalThis as typeof globalThis & {
                app?: { plugins?: { plugins?: Record<string, RestorePlugin> } };
                diffzipExtractCalls?: Array<{ files: string[]; zipName: string }>;
                diffzipMirrorRestore?: Promise<void>;
                diffzipOriginalExtract?: RestorePlugin["extractWithoutWakeLock"];
            };
            const plugin = root.app?.plugins?.plugins?.[pluginId];
            if (!plugin) throw new Error(`DiffZip is not loaded: ${pluginId}`);
            if (paths.length === 0) throw new Error("Mirror deletion fixtures were unavailable");
            root.diffzipExtractCalls = [];
            root.diffzipOriginalExtract = plugin.extractWithoutWakeLock;
            plugin.extractWithoutWakeLock = async (zipName, files) => {
                root.diffzipExtractCalls?.push({
                    zipName,
                    files: Array.isArray(files) ? files : [files],
                });
            };
            root.diffzipMirrorRestore = plugin.restoreVault(false, true);
        },
        { pluginId: DIFFZIP_PLUGIN_ID, paths: MIRROR_DELETION_FIXTURE_PATHS }
    );

    try {
        const modal = page.locator(".modal-container").filter({ hasText: "Restore Confirmation" }).last();
        await modal.waitFor({ state: "visible", timeout: 10_000 });
        await modal.getByRole("button", { name: "Yes, restore them!", exact: true }).click();
        return await page.evaluate(
            async ({ pluginId, paths }) => {
                interface RestorePlugin {
                    vaultAccess: { stat(path: string): Promise<unknown> };
                }
                const root = globalThis as typeof globalThis & {
                    app?: { plugins?: { plugins?: Record<string, RestorePlugin> } };
                    diffzipExtractCalls?: Array<{ files: string[]; zipName: string }>;
                    diffzipMirrorRestore?: Promise<void>;
                };
                await root.diffzipMirrorRestore;
                const plugin = root.app?.plugins?.plugins?.[pluginId];
                if (!plugin) throw new Error(`DiffZip is not loaded: ${pluginId}`);
                const extractCalls = root.diffzipExtractCalls ?? [];
                const deletionCandidateStats = await Promise.all(paths.map((path) => plugin.vaultAccess.stat(path)));
                return {
                    deletionCandidateStillExists: deletionCandidateStats.some(Boolean),
                    deletionCandidateWasExtracted: extractCalls.some(({ files }) =>
                        paths.some((path) => files.includes(path))
                    ),
                };
            },
            { pluginId: DIFFZIP_PLUGIN_ID, paths: MIRROR_DELETION_FIXTURE_PATHS }
        );
    } finally {
        await page.evaluate((pluginId) => {
            interface RestorePlugin {
                extractWithoutWakeLock(
                    zipName: string,
                    files: string | string[],
                    restoreAs?: string,
                    prefix?: string
                ): Promise<void>;
            }
            const root = globalThis as typeof globalThis & {
                app?: { plugins?: { plugins?: Record<string, RestorePlugin> } };
                diffzipExtractCalls?: Array<{ files: string[]; zipName: string }>;
                diffzipMirrorRestore?: Promise<void>;
                diffzipOriginalExtract?: RestorePlugin["extractWithoutWakeLock"];
            };
            const plugin = root.app?.plugins?.plugins?.[pluginId];
            if (plugin && root.diffzipOriginalExtract) {
                plugin.extractWithoutWakeLock = root.diffzipOriginalExtract;
            }
            delete root.diffzipExtractCalls;
            delete root.diffzipMirrorRestore;
            delete root.diffzipOriginalExtract;
        }, DIFFZIP_PLUGIN_ID);
    }
}

async function observeSelectedRevisionSemantics(testSession: DiffZipTestSession): Promise<RevisionEvidence> {
    return await withObsidianPage(testSession.session.remoteDebuggingPort, async (page) => {
        await page.evaluate(
            ({ pluginId, normalPath, normalTimestamp, deletionPath, deletionTimestamp }) => {
                interface RestorePlugin {
                    extractWithoutWakeLock(
                        zipName: string,
                        files: string | string[],
                        restoreAs?: string,
                        prefix?: string
                    ): Promise<void>;
                    restoreVault(
                        onlyNew?: boolean,
                        deleteMissing?: boolean,
                        fileFilter?: Record<string, number>
                    ): Promise<void>;
                    operationWakeLock: { activeLeaseCount: number };
                    vaultAccess: {
                        deleteBinary(path: string): Promise<boolean>;
                        stat(path: string): Promise<unknown>;
                    };
                }
                const root = globalThis as typeof globalThis & {
                    app?: { plugins?: { plugins?: Record<string, RestorePlugin> } };
                    diffzipRevisionDeletes?: string[];
                    diffzipRevisionExtracts?: string[];
                    diffzipRevisionLeaseCounts?: number[];
                    diffzipRevisionRestore?: Promise<void>;
                    diffzipRevisionOriginalDelete?: RestorePlugin["vaultAccess"]["deleteBinary"];
                    diffzipRevisionOriginalExtract?: RestorePlugin["extractWithoutWakeLock"];
                    diffzipRevisionOriginalStat?: RestorePlugin["vaultAccess"]["stat"];
                };
                const plugin = root.app?.plugins?.plugins?.[pluginId];
                if (!plugin) throw new Error(`DiffZip is not loaded: ${pluginId}`);
                root.diffzipRevisionDeletes = [];
                root.diffzipRevisionExtracts = [];
                root.diffzipRevisionLeaseCounts = [];
                root.diffzipRevisionOriginalDelete = plugin.vaultAccess.deleteBinary;
                root.diffzipRevisionOriginalExtract = plugin.extractWithoutWakeLock;
                root.diffzipRevisionOriginalStat = plugin.vaultAccess.stat;
                plugin.vaultAccess.stat = async (path) => {
                    root.diffzipRevisionLeaseCounts?.push(plugin.operationWakeLock.activeLeaseCount);
                    return await root.diffzipRevisionOriginalStat?.call(plugin.vaultAccess, path);
                };
                plugin.vaultAccess.deleteBinary = async (path) => {
                    root.diffzipRevisionLeaseCounts?.push(plugin.operationWakeLock.activeLeaseCount);
                    root.diffzipRevisionDeletes?.push(path);
                    return true;
                };
                plugin.extractWithoutWakeLock = async (_zipName, files) => {
                    root.diffzipRevisionLeaseCounts?.push(plugin.operationWakeLock.activeLeaseCount);
                    root.diffzipRevisionExtracts?.push(...(Array.isArray(files) ? files : [files]));
                };
                root.diffzipRevisionRestore = plugin.restoreVault(false, true, {
                    [normalPath]: normalTimestamp,
                    [deletionPath]: deletionTimestamp,
                });
            },
            {
                pluginId: DIFFZIP_PLUGIN_ID,
                normalPath: NORMAL_BEFORE_DELETE_PATH,
                normalTimestamp: NORMAL_BEFORE_DELETE_TIMESTAMP,
                deletionPath: DELETE_BEFORE_RECREATE_PATH,
                deletionTimestamp: DELETE_BEFORE_RECREATE_TIMESTAMP,
            }
        );

        try {
            const modal = page.locator(".modal-container").filter({ hasText: "Restore Confirmation" }).last();
            await modal.waitFor({ state: "visible", timeout: 10_000 });
            const activeLeasesAtConfirmation = await page.evaluate((pluginId) => {
                const root = globalThis as typeof globalThis & {
                    app?: {
                        plugins?: {
                            plugins?: Record<string, { operationWakeLock: { activeLeaseCount: number } }>;
                        };
                    };
                };
                const plugin = root.app?.plugins?.plugins?.[pluginId];
                if (!plugin) throw new Error(`DiffZip is not loaded: ${pluginId}`);
                return plugin.operationWakeLock.activeLeaseCount;
            }, DIFFZIP_PLUGIN_ID);
            await modal.getByRole("button", { name: "Yes, restore them!", exact: true }).click();
            const evidence = await page.evaluate(async (pluginId) => {
                const root = globalThis as typeof globalThis & {
                    app?: {
                        plugins?: {
                            plugins?: Record<string, { operationWakeLock: { activeLeaseCount: number } }>;
                        };
                    };
                    diffzipRevisionDeletes?: string[];
                    diffzipRevisionExtracts?: string[];
                    diffzipRevisionLeaseCounts?: number[];
                    diffzipRevisionRestore?: Promise<void>;
                };
                await root.diffzipRevisionRestore;
                const plugin = root.app?.plugins?.plugins?.[pluginId];
                if (!plugin) throw new Error(`DiffZip is not loaded: ${pluginId}`);
                return {
                    activeLeaseCounts: root.diffzipRevisionLeaseCounts ?? [],
                    activeLeasesAfter: plugin.operationWakeLock.activeLeaseCount,
                    deleted: root.diffzipRevisionDeletes ?? [],
                    extracted: root.diffzipRevisionExtracts ?? [],
                };
            }, DIFFZIP_PLUGIN_ID);
            return { ...evidence, activeLeasesAtConfirmation };
        } finally {
            await page.evaluate((pluginId) => {
                interface RestorePlugin {
                    extractWithoutWakeLock(
                        zipName: string,
                        files: string | string[],
                        restoreAs?: string,
                        prefix?: string
                    ): Promise<void>;
                    vaultAccess: {
                        deleteBinary(path: string): Promise<boolean>;
                        stat(path: string): Promise<unknown>;
                    };
                }
                const root = globalThis as typeof globalThis & {
                    app?: { plugins?: { plugins?: Record<string, RestorePlugin> } };
                    diffzipRevisionDeletes?: string[];
                    diffzipRevisionExtracts?: string[];
                    diffzipRevisionLeaseCounts?: number[];
                    diffzipRevisionRestore?: Promise<void>;
                    diffzipRevisionOriginalDelete?: RestorePlugin["vaultAccess"]["deleteBinary"];
                    diffzipRevisionOriginalExtract?: RestorePlugin["extractWithoutWakeLock"];
                    diffzipRevisionOriginalStat?: (path: string) => Promise<unknown>;
                };
                const plugin = root.app?.plugins?.plugins?.[pluginId];
                if (plugin && root.diffzipRevisionOriginalDelete) {
                    plugin.vaultAccess.deleteBinary = root.diffzipRevisionOriginalDelete;
                }
                if (plugin && root.diffzipRevisionOriginalExtract) {
                    plugin.extractWithoutWakeLock = root.diffzipRevisionOriginalExtract;
                }
                if (plugin && root.diffzipRevisionOriginalStat) {
                    plugin.vaultAccess.stat = root.diffzipRevisionOriginalStat;
                }
                delete root.diffzipRevisionDeletes;
                delete root.diffzipRevisionExtracts;
                delete root.diffzipRevisionLeaseCounts;
                delete root.diffzipRevisionRestore;
                delete root.diffzipRevisionOriginalDelete;
                delete root.diffzipRevisionOriginalExtract;
                delete root.diffzipRevisionOriginalStat;
            }, DIFFZIP_PLUGIN_ID);
        }
    });
}

async function observeFailureSemantics(testSession: DiffZipTestSession): Promise<FailureEvidence> {
    return await withObsidianPage(testSession.session.remoteDebuggingPort, async (page) => {
        const extractionFailures = await page.evaluate(
            async ({ pluginId, probePath, probeZip }) => {
                interface RestorePlugin {
                    backups: {
                        readBinary(path: string): Promise<ArrayBuffer | false>;
                    };
                    extract(zipName: string, files: string | string[]): Promise<void>;
                    vaultAccess: {
                        writeBinary(path: string, data: ArrayBuffer): Promise<boolean>;
                    };
                }
                const root = globalThis as typeof globalThis & {
                    app?: { plugins?: { plugins?: Record<string, RestorePlugin> } };
                };
                const plugin = root.app?.plugins?.plugins?.[pluginId];
                if (!plugin) throw new Error(`DiffZip is not loaded: ${pluginId}`);
                let missingArchiveRejected = false;
                try {
                    await plugin.extract("absent.zip", [probePath]);
                } catch {
                    missingArchiveRejected = true;
                }

                let missingEntryRejected = false;
                try {
                    await plugin.extract(probeZip, ["failure/not-in-archive.md"]);
                } catch {
                    missingEntryRejected = true;
                }

                const originalReadBinary = plugin.backups.readBinary;
                plugin.backups.readBinary = async () => false;
                let readFailureRejected = false;
                try {
                    await plugin.extract(probeZip, [probePath]);
                } catch {
                    readFailureRejected = true;
                }
                plugin.backups.readBinary = originalReadBinary;

                const originalWriteBinary = plugin.vaultAccess.writeBinary;
                plugin.vaultAccess.writeBinary = async () => false;
                let writeFailureRejected = false;
                try {
                    await plugin.extract(probeZip, [probePath]);
                } catch {
                    writeFailureRejected = true;
                }
                plugin.vaultAccess.writeBinary = originalWriteBinary;

                return { missingArchiveRejected, missingEntryRejected, readFailureRejected, writeFailureRejected };
            },
            { pluginId: DIFFZIP_PLUGIN_ID, probePath: EXTRACTION_PROBE_PATH, probeZip: EXTRACTION_PROBE_ZIP }
        );

        await page.evaluate((pluginId) => {
            interface RestorePlugin {
                restoreVault(onlyNew?: boolean, deleteMissing?: boolean): Promise<void>;
            }
            const root = globalThis as typeof globalThis & {
                app?: { plugins?: { plugins?: Record<string, RestorePlugin> } };
                diffzipFailedRestore?: Promise<boolean>;
            };
            const plugin = root.app?.plugins?.plugins?.[pluginId];
            if (!plugin) throw new Error(`DiffZip is not loaded: ${pluginId}`);
            root.diffzipFailedRestore = plugin.restoreVault(false, true).then(
                () => false,
                () => true
            );
        }, DIFFZIP_PLUGIN_ID);
        const modal = page.locator(".modal-container").filter({ hasText: "Restore Confirmation" }).last();
        await modal.waitFor({ state: "visible", timeout: 10_000 });
        await modal.getByRole("button", { name: "Yes, restore them!", exact: true }).click();
        const restoreFailure = await page.evaluate(
            async ({ pluginId, deletionPath }) => {
                interface RestorePlugin {
                    vaultAccess: { stat(path: string): Promise<unknown> };
                }
                const root = globalThis as typeof globalThis & {
                    app?: { plugins?: { plugins?: Record<string, RestorePlugin> } };
                    diffzipFailedRestore?: Promise<boolean>;
                };
                const failedRestoreRejected = (await root.diffzipFailedRestore) ?? false;
                delete root.diffzipFailedRestore;
                const plugin = root.app?.plugins?.plugins?.[pluginId];
                if (!plugin) throw new Error(`DiffZip is not loaded: ${pluginId}`);
                return {
                    failedRestoreRejected,
                    deletionCandidateStillExists: Boolean(await plugin.vaultAccess.stat(deletionPath)),
                };
            },
            { pluginId: DIFFZIP_PLUGIN_ID, deletionPath: FAILED_RESTORE_DELETION_PATH }
        );
        return { ...extractionFailures, ...restoreFailure };
    });
}

async function verifyMirrorDeleteSemantics(testSession: DiffZipTestSession): Promise<void> {
    await withObsidianPage(testSession.session.remoteDebuggingPort, async (page) => {
        const mode = await observeAllDeleteMode(page);
        const execution = await observeDeleteExecution(page);
        const failures: string[] = [];
        if (mode.onlyNew || !mode.deleteMissing) {
            failures.push(`all-delete mapped to ${JSON.stringify(mode)}`);
        }
        if (execution.deletionCandidateStillExists) {
            failures.push("a confirmed mirror deletion candidate remained in the Vault");
        }
        if (execution.deletionCandidateWasExtracted) {
            failures.push("a mirror deletion candidate was also sent to extract");
        }
        if (failures.length > 0) {
            throw new Error(`Mirror delete semantics failed: ${failures.join("; ")}`);
        }
    });
}

async function main(): Promise<void> {
    const failures: string[] = [];
    let historySession: DiffZipTestSession | undefined;
    let failureSession: DiffZipTestSession | undefined;
    let largeSession: DiffZipTestSession | undefined;
    try {
        historySession = await startDiffZipTestSession({ restorePlan: "history" });
        const revision = await observeSelectedRevisionSemantics(historySession);
        if (!revision.extracted.includes(NORMAL_BEFORE_DELETE_PATH)) {
            failures.push("a selected normal revision was not planned for extraction");
        }
        if (revision.deleted.includes(NORMAL_BEFORE_DELETE_PATH)) {
            failures.push("a selected normal revision was planned for deletion");
        }
        if (revision.extracted.includes(DELETE_BEFORE_RECREATE_PATH)) {
            failures.push("a selected deletion revision was planned for extraction");
        }
        if (!revision.deleted.includes(DELETE_BEFORE_RECREATE_PATH)) {
            failures.push("a selected deletion revision was not planned for deletion");
        }
        if (revision.activeLeaseCounts.length === 0 || revision.activeLeaseCounts.some((count) => count !== 1)) {
            failures.push(
                `restore work ran outside one wake-lock lease: ${JSON.stringify(revision.activeLeaseCounts)}`
            );
        }
        if (revision.activeLeasesAtConfirmation !== 0) {
            failures.push(`restore confirmation held a wake-lock lease: ${revision.activeLeasesAtConfirmation}`);
        }
        if (revision.activeLeasesAfter !== 0) {
            failures.push(`restore wake-lock lease remained active: ${revision.activeLeasesAfter}`);
        }
        await stopDiffZipTestSession(historySession);
        historySession = undefined;

        failureSession = await startDiffZipTestSession({ restorePlan: "failure" });
        const failure = await observeFailureSemantics(failureSession);
        if (!failure.missingArchiveRejected) failures.push("a missing archive was reported as restored");
        if (!failure.missingEntryRejected) failures.push("a missing ZIP entry was reported as restored");
        if (!failure.readFailureRejected) failures.push("an archive read failure was reported as restored");
        if (!failure.writeFailureRejected) failures.push("a Vault write failure was reported as restored");
        if (!failure.failedRestoreRejected) failures.push("a failed restore resolved successfully");
        if (!failure.deletionCandidateStillExists) failures.push("a failed restore deleted a mirror candidate");
        await stopDiffZipTestSession(failureSession);
        failureSession = undefined;

        if (failures.length > 0) {
            throw new Error(`Mirror delete regression cases failed: ${failures.join("; ")}`);
        }

        largeSession = await startDiffZipTestSession({ restorePlan: "large" });
        await verifyMirrorDeleteSemantics(largeSession);
        console.log("DiffZip mirror delete semantics passed in real Obsidian");
    } finally {
        if (historySession) await stopDiffZipTestSession(historySession);
        if (failureSession) await stopDiffZipTestSession(failureSession);
        if (largeSession) await stopDiffZipTestSession(largeSession);
    }
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
});
