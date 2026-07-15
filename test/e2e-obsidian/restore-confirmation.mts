import {
    assertLocatorHasMinimumTouchTarget,
    assertLocatorWithinSafeArea,
    assertNoHorizontalOverflow,
    withObsidianPage,
} from "@vrtmrz/obsidian-test-session";
import type { Locator, Page } from "playwright";
import {
    DIFFZIP_PLUGIN_ID,
    MIRROR_DELETION_FIXTURE_PATHS,
    RESTORE_FIXTURE_PATHS,
    RESTORE_FIXTURE_ZIP_COUNT,
    startDiffZipTestSession,
    stopDiffZipTestSession,
    type DiffZipTestSession,
} from "./harness.mts";

const PHONE_SAFE_AREA_INSETS = {
    top: 47,
    right: 0,
    bottom: 34,
    left: 0,
} as const;

interface RestoreConfirmationScenario {
    deleteMissing: boolean;
    dismissWithEscape: boolean;
}

async function requestRestore(page: Page, deleteMissing: boolean): Promise<void> {
    return await page.evaluate(
        async ({ pluginId, shouldDeleteMissing }) => {
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
            await plugin.restoreVault(false, shouldDeleteMissing);
        },
        { pluginId: DIFFZIP_PLUGIN_ID, shouldDeleteMissing: deleteMissing }
    );
}

async function enterPhoneReview(page: Page): Promise<void> {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => {
        document.body.classList.add("is-mobile", "is-phone");
        document.body.style.setProperty("--safe-area-inset-top", "47px");
        document.body.style.setProperty("--safe-area-inset-right", "0px");
        document.body.style.setProperty("--safe-area-inset-bottom", "34px");
        document.body.style.setProperty("--safe-area-inset-left", "0px");
    });
}

async function leavePhoneReview(page: Page): Promise<void> {
    await page.evaluate(() => {
        document.body.classList.remove("is-mobile", "is-phone");
        for (const property of [
            "--safe-area-inset-top",
            "--safe-area-inset-right",
            "--safe-area-inset-bottom",
            "--safe-area-inset-left",
        ]) {
            document.body.style.removeProperty(property);
        }
    });
    await page.setViewportSize({ width: 1280, height: 960 });
}

async function assertLargeConfirmationLayout(page: Page, modal: Locator, deleteMissing: boolean): Promise<void> {
    const dialogue = modal.locator(".modal");
    const title = dialogue.locator(".modal-title");
    const closeButton = dialogue.locator(".modal-close-button");
    const content = dialogue.locator(".modal-content");
    const actions = dialogue.locator(".setting-item-control").last();
    const restoreButton = dialogue.getByRole("button", {
        name: deleteMissing ? "Restore and delete" : "Yes, restore them!",
        exact: true,
    });
    const cancelButton = dialogue.getByRole("button", { name: "Cancel", exact: true });

    await assertLocatorWithinSafeArea(page, title, {
        label: "restore confirmation title",
        safeAreaInsets: PHONE_SAFE_AREA_INSETS,
    });
    await assertLocatorWithinSafeArea(page, closeButton, {
        label: "restore confirmation close button",
        safeAreaInsets: PHONE_SAFE_AREA_INSETS,
    });
    await assertLocatorHasMinimumTouchTarget(page, closeButton, {
        label: "restore confirmation close button",
    });

    await content.locator("details").evaluateAll((elements) => {
        for (const element of elements) element.setAttribute("open", "");
    });
    await assertNoHorizontalOverflow(page, content, {
        label: "expanded restore confirmation content",
    });

    await actions.scrollIntoViewIfNeeded();
    await assertLocatorWithinSafeArea(page, actions, {
        label: "restore confirmation actions",
        safeAreaInsets: PHONE_SAFE_AREA_INSETS,
    });
    await assertNoHorizontalOverflow(page, actions, {
        label: "restore confirmation actions",
    });
    await assertLocatorHasMinimumTouchTarget(page, restoreButton, {
        label: "restore confirmation restore button",
    });
    await assertLocatorHasMinimumTouchTarget(page, cancelButton, {
        label: "restore confirmation cancel button",
    });
}

async function verifyCancellation(
    testSession: DiffZipTestSession,
    { deleteMissing, dismissWithEscape }: RestoreConfirmationScenario
): Promise<void> {
    await withObsidianPage(testSession.session.remoteDebuggingPort, async (page) => {
        await enterPhoneReview(page);
        try {
            const restore = requestRestore(page, deleteMissing);
            const confirmationTitle = deleteMissing ? "Restore and Delete Confirmation" : "Restore Confirmation";
            const modal = page.locator(".modal-container").filter({ hasText: confirmationTitle }).last();
            await modal.waitFor({ state: "visible", timeout: 10_000 });
            await modal.getByText(confirmationTitle, { exact: true }).waitFor({ state: "visible", timeout: 5_000 });
            const expectedDetailCount = deleteMissing ? 2 : 1;
            await modal
                .locator("details")
                .nth(expectedDetailCount - 1)
                .waitFor({ state: "attached", timeout: 5_000 });

            const content = await modal.textContent();
            if (content === null) {
                throw new Error("Restore summary was not rendered");
            }
            const normalRestoreSummary =
                `We have ${RESTORE_FIXTURE_PATHS.length} files to restore ` + `on ${RESTORE_FIXTURE_ZIP_COUNT} ZIPs.`;
            if (!content.includes(normalRestoreSummary)) {
                throw new Error(`${deleteMissing ? "Mirror" : "Normal"} restore summary was not rendered: ${content}`);
            }
            for (const path of [RESTORE_FIXTURE_PATHS.at(0), RESTORE_FIXTURE_PATHS.at(-1)]) {
                if (!path || !content.includes(path)) {
                    throw new Error(`Restore file was not rendered: ${path ?? "<undefined>"}`);
                }
            }
            const deletionSummary = `And ${MIRROR_DELETION_FIXTURE_PATHS.length} files will be deleted.`;
            if (deleteMissing) {
                if (!content.includes(deletionSummary)) {
                    throw new Error(`Mirror deletion summary was not rendered: ${content}`);
                }
                for (const path of [MIRROR_DELETION_FIXTURE_PATHS.at(0), MIRROR_DELETION_FIXTURE_PATHS.at(-1)]) {
                    if (!path || !content.includes(path)) {
                        throw new Error(`Mirror deletion candidate was not rendered: ${path ?? "<undefined>"}`);
                    }
                }
            } else if (content.includes(deletionSummary) || content.includes(MIRROR_DELETION_FIXTURE_PATHS[0])) {
                throw new Error(`Mirror deletion candidates leaked into a normal restore: ${content}`);
            }

            await assertLargeConfirmationLayout(page, modal, deleteMissing);
            if (dismissWithEscape) {
                await page.keyboard.press("Escape");
            } else {
                await modal.getByRole("button", { name: "Cancel", exact: true }).click();
            }
            await restore;
            await modal.waitFor({ state: "detached", timeout: 10_000 });
            await page.getByText("Cancelled", { exact: true }).last().waitFor({ state: "visible", timeout: 5_000 });
        } finally {
            await leavePhoneReview(page);
        }
    });
}

async function main(): Promise<void> {
    let testSession: DiffZipTestSession | undefined;
    try {
        testSession = await startDiffZipTestSession({ restorePlan: "large" });
        await verifyCancellation(testSession, { deleteMissing: false, dismissWithEscape: false });
        await verifyCancellation(testSession, { deleteMissing: true, dismissWithEscape: true });
        console.log("DiffZip large restore and mirror confirmations passed in real Obsidian");
    } finally {
        if (testSession) await stopDiffZipTestSession(testSession);
    }
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
});
