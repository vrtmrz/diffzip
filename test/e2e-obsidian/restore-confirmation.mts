import { withObsidianPage } from "@vrtmrz/obsidian-test-session";
import {
    DIFFZIP_PLUGIN_ID,
    startDiffZipTestSession,
    stopDiffZipTestSession,
    type DiffZipTestSession,
} from "./harness.mts";

async function requestRestore(page: import("playwright").Page): Promise<void> {
    return await page.evaluate(async (pluginId) => {
        const obsidianApp = (
            globalThis as typeof globalThis & {
                app?: {
                    plugins?: {
                        plugins?: Record<
                            string,
                            { restoreVault(onlyNew: boolean, deleteMissing: boolean): Promise<void> }
                        >;
                    };
                };
            }
        ).app;
        const plugin = obsidianApp?.plugins?.plugins?.[pluginId];
        if (!plugin) throw new Error(`DiffZip is not loaded: ${pluginId}`);
        await plugin.restoreVault(false, false);
    }, DIFFZIP_PLUGIN_ID);
}

async function verifyCancellation(testSession: DiffZipTestSession, dismissWithEscape: boolean): Promise<void> {
    await withObsidianPage(testSession.session.remoteDebuggingPort, async (page) => {
        const restore = requestRestore(page);
        const modal = page.locator(".modal-container").filter({ hasText: "Restore Confirmation" }).last();
        await modal.waitFor({ state: "visible", timeout: 10_000 });
        const content = await modal.textContent();
        if (!content?.includes("We have 1 files to restore on 1 ZIPs.")) {
            throw new Error(`Restore summary was not rendered: ${content ?? "<empty>"}`);
        }
        if (!content.includes("notes/restore-me.md")) {
            throw new Error(`Restore file was not rendered: ${content}`);
        }
        if (dismissWithEscape) {
            await page.keyboard.press("Escape");
        } else {
            await modal.getByRole("button", { name: "Cancel", exact: true }).click();
        }
        await restore;
        await modal.waitFor({ state: "detached", timeout: 10_000 });
        await page.getByText("Cancelled", { exact: true }).last().waitFor({ state: "visible", timeout: 5_000 });
    });
}

async function main(): Promise<void> {
    let testSession: DiffZipTestSession | undefined;
    try {
        testSession = await startDiffZipTestSession();
        await verifyCancellation(testSession, false);
        await verifyCancellation(testSession, true);
        console.log("DiffZip restore confirmation passed in real Obsidian");
    } finally {
        if (testSession) await stopDiffZipTestSession(testSession);
    }
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
});
