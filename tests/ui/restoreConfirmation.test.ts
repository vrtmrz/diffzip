import { createUiTestHarness } from "@vrtmrz/obsidian-plugin-kit/testing";
import { describe, expect, it } from "vitest";
import {
    confirmRestore,
    RESTORE_CONFIRMATION_INTERACTION_ID,
} from "../../src/restoreConfirmation.ts";

describe("confirmRestore", () => {
    it("records the restore request and accepts the restore action", async () => {
        const harness = createUiTestHarness([
            {
                kind: "confirmAction",
                interactionId: RESTORE_CONFIRMATION_INTERACTION_ID,
                value: "restore",
            },
        ]);
        const filesByZip = new Map([
            ["backup-2.zip", ["notes/b.md"]],
            ["backup-1.zip", ["notes/a.md"]],
        ]);

        const confirmed = await confirmRestore(harness.ui, {
            processFileCount: 2,
            filesByZip,
            deleteMissing: true,
            deletingFiles: ["notes/removed.md"],
        });

        expect(confirmed).toBe(true);
        harness.assertDone();
        const [request] = harness.transcript;
        expect(request).toMatchObject({
            kind: "confirmAction",
            interactionId: RESTORE_CONFIRMATION_INTERACTION_ID,
            options: { defaultAction: "cancel" },
        });
        if (request?.kind !== "confirmAction") throw new Error("Expected a confirmation request");
        expect(request.options.message).toContain("- notes/a.md  (backup-1.zip)");
        expect(request.options.message).toContain("- notes/removed.md");
    });

    it.each(["cancel", null] as const)("treats %s as cancellation", async (value) => {
        const harness = createUiTestHarness([
            {
                kind: "confirmAction",
                interactionId: RESTORE_CONFIRMATION_INTERACTION_ID,
                value,
            },
        ]);

        const confirmed = await confirmRestore(harness.ui, {
            processFileCount: 1,
            filesByZip: new Map([["backup.zip", ["note.md"]]]),
            deleteMissing: false,
            deletingFiles: [],
        });

        expect(confirmed).toBe(false);
        harness.assertDone();
    });
});
