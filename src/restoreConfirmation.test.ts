import type { ConfirmActionOptions, UiInteractions } from "@vrtmrz/obsidian-plugin-kit/ui";
import { confirmRestore, RESTORE_CONFIRMATION_INTERACTION_ID } from "./restoreConfirmation.ts";

declare const Deno: {
    test: (name: string, fn: () => void | Promise<void>) => void;
};

function assertEquals<T>(actual: T, expected: T, message: string): void {
    if (actual !== expected) {
        throw new Error(`${message}: expected=${String(expected)}, actual=${String(actual)}`);
    }
}

Deno.test("restore confirmation: identifies a destructive restore in its title and action", async () => {
    let request: { interactionId?: string; options: ConfirmActionOptions<string> } | undefined;
    const ui = {
        confirmAction: async (options: ConfirmActionOptions<string>, interactionId?: string) => {
            request = { interactionId, options };
            return "cancel";
        },
    } as UiInteractions;

    await confirmRestore(ui, {
        processFileCount: 1,
        filesByZip: new Map([["backup.zip", ["restored.md"]]]),
        deleteMissing: true,
        deletingFiles: ["deleted.md"],
    });

    if (!request) throw new Error("The confirmation interaction was not requested");
    assertEquals(request.interactionId, RESTORE_CONFIRMATION_INTERACTION_ID, "interaction ID");
    assertEquals(request.options.title, "Restore and Delete Confirmation", "destructive confirmation title");
    assertEquals(request.options.labels?.restore, "Restore and delete", "destructive confirmation action");
    assertEquals(request.options.defaultAction, "cancel", "safe default action");
});
