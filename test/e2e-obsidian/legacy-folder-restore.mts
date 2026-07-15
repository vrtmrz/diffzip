import { withObsidianPage } from "@vrtmrz/obsidian-test-session";
import type { Page } from "playwright";
import {
    DELETE_BEFORE_RECREATE_PATH,
    DIFFZIP_PLUGIN_ID,
    LEGACY_RESTORED_CONTENT,
    startDiffZipTestSession,
    stopDiffZipTestSession,
    type DiffZipTestSession,
} from "./harness.mts";

async function chooseNextPromptItem(page: Page, placeholder: string, moveDown: boolean): Promise<void> {
    const input = page.locator(`input.prompt-input[placeholder*="${placeholder}"]`).last();
    await input.waitFor({ state: "visible", timeout: 10_000 });
    if (moveDown) await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await input.waitFor({ state: "detached", timeout: 10_000 });
}

async function exerciseLegacyFolderRestore(testSession: DiffZipTestSession): Promise<void> {
    await withObsidianPage(testSession.session.remoteDebuggingPort, async (page) => {
        await page.evaluate((pluginId) => {
            interface RestorePlugin {
                selectAndRestoreFolder(): Promise<void>;
            }
            const root = globalThis as typeof globalThis & {
                app?: { plugins?: { plugins?: Record<string, RestorePlugin> } };
                diffzipLegacyFolderRestore?: Promise<boolean>;
            };
            const plugin = root.app?.plugins?.plugins?.[pluginId];
            if (!plugin) throw new Error(`DiffZip is not loaded: ${pluginId}`);
            root.diffzipLegacyFolderRestore = plugin.selectAndRestoreFolder().then(
                () => false,
                () => true
            );
        }, DIFFZIP_PLUGIN_ID);

        await chooseNextPromptItem(page, "Select file", true);
        await chooseNextPromptItem(page, "Until?", true);
        await chooseNextPromptItem(page, "Are you sure to restore", false);

        const evidence = await page.evaluate(
            async ({ path, pluginId }) => {
                const root = globalThis as typeof globalThis & {
                    app?: {
                        plugins?: { plugins?: Record<string, unknown> };
                        vault?: { adapter: { read(path: string): Promise<string> } };
                    };
                    diffzipLegacyFolderRestore?: Promise<boolean>;
                };
                const rejected = (await root.diffzipLegacyFolderRestore) ?? false;
                delete root.diffzipLegacyFolderRestore;
                if (!root.app?.plugins?.plugins?.[pluginId]) throw new Error(`DiffZip is not loaded: ${pluginId}`);
                const restoredContent = await root.app.vault?.adapter.read(path);
                return { rejected, restoredContent };
            },
            { path: DELETE_BEFORE_RECREATE_PATH, pluginId: DIFFZIP_PLUGIN_ID }
        );
        if (evidence.restoredContent !== LEGACY_RESTORED_CONTENT) {
            throw new Error(`The ordinary historical revision was not restored: ${JSON.stringify(evidence)}`);
        }
        if (evidence.rejected) {
            throw new Error("The legacy folder restore rejected a contentless deletion record");
        }
    });
}

async function main(): Promise<void> {
    let testSession: DiffZipTestSession | undefined;
    try {
        testSession = await startDiffZipTestSession({ restorePlan: "history" });
        await exerciseLegacyFolderRestore(testSession);
        console.log("DiffZip legacy folder restore passed in real Obsidian");
    } finally {
        if (testSession) await stopDiffZipTestSession(testSession);
    }
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
});
