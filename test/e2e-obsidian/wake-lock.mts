import { withObsidianPage } from "@vrtmrz/obsidian-test-session";
import {
    DIFFZIP_PLUGIN_ID,
    startDiffZipTestSession,
    stopDiffZipTestSession,
    type DiffZipTestSession,
} from "./harness.mts";

interface WakeLockBackupEvidence {
    backupActiveDuring: number;
    backupActiveAfter: number;
    restoreActiveDuring: number;
    restoreActiveAfter: number;
    supported: boolean;
    tocContainsFixture: boolean;
    restoredContent: string;
}

async function verifyBackupWakeLock(testSession: DiffZipTestSession): Promise<WakeLockBackupEvidence> {
    return await withObsidianPage(testSession.session.remoteDebuggingPort, async (page) => {
        return await page.evaluate(async (pluginId) => {
            const obsidianApp = (
                globalThis as typeof globalThis & {
                    app?: {
                        plugins?: {
                            plugins?: Record<
                                string,
                                {
                                    operationWakeLock: {
                                        activeLeaseCount: number;
                                        supported: boolean;
                                    };
                                    createZip(verbosity: boolean): Promise<void>;
                                    extract(zipFile: string, extractFiles: string[]): Promise<void>;
                                    loadTOC(): Promise<Record<string, { history: { zipName: string }[] }>>;
                                }
                            >;
                        };
                        vault?: {
                            adapter: {
                                read(path: string): Promise<string>;
                            };
                            create(path: string, data: string): Promise<unknown>;
                            delete(file: unknown, force: boolean): Promise<void>;
                            getAbstractFileByPath(path: string): unknown;
                        };
                    };
                }
            ).app;
            const plugin = obsidianApp?.plugins?.plugins?.[pluginId];
            const vault = obsidianApp?.vault;
            if (!plugin || !vault) throw new Error(`DiffZip is not loaded: ${pluginId}`);

            const fixture = "wake-lock-e2e.md";
            await vault.create(fixture, "Wake Lock E2E");
            const backup = plugin.createZip(false);
            const backupActiveDuring = plugin.operationWakeLock.activeLeaseCount;
            const supported = plugin.operationWakeLock.supported;
            await backup;
            const backupActiveAfter = plugin.operationWakeLock.activeLeaseCount;
            const tocText = await vault.adapter.read("backup/backupinfo.md");
            const toc = await plugin.loadTOC();
            const zipName = toc[fixture]?.history.at(-1)?.zipName;
            if (!zipName) throw new Error(`The backup did not record ${fixture}`);
            const abstractFile = vault.getAbstractFileByPath(fixture);
            if (!abstractFile) throw new Error(`The backup fixture disappeared: ${fixture}`);
            await vault.delete(abstractFile, true);

            const restore = plugin.extract(zipName, [fixture]);
            const restoreActiveDuring = plugin.operationWakeLock.activeLeaseCount;
            await restore;

            return {
                backupActiveDuring,
                backupActiveAfter,
                restoreActiveDuring,
                restoreActiveAfter: plugin.operationWakeLock.activeLeaseCount,
                supported,
                tocContainsFixture: tocText.includes(fixture),
                restoredContent: await vault.adapter.read(fixture),
            };
        }, DIFFZIP_PLUGIN_ID);
    });
}

async function main(): Promise<void> {
    let testSession: DiffZipTestSession | undefined;
    try {
        testSession = await startDiffZipTestSession();
        const evidence = await verifyBackupWakeLock(testSession);
        if (evidence.backupActiveDuring !== 1 || evidence.restoreActiveDuring !== 1) {
            throw new Error(`Expected one active operation lease, received ${JSON.stringify(evidence)}`);
        }
        if (evidence.backupActiveAfter !== 0 || evidence.restoreActiveAfter !== 0) {
            throw new Error(`An operation wake lock was not released: ${JSON.stringify(evidence)}`);
        }
        if (!evidence.tocContainsFixture) {
            throw new Error(`The backup did not record its fixture: ${JSON.stringify(evidence)}`);
        }
        if (evidence.restoredContent !== "Wake Lock E2E") {
            throw new Error(`The restore did not reproduce its fixture: ${JSON.stringify(evidence)}`);
        }
        console.log(`DiffZip operation wake-lock lifecycle passed in real Obsidian: ${JSON.stringify(evidence)}`);
    } finally {
        if (testSession) await stopDiffZipTestSession(testSession);
    }
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
});
