import {
    createUiTestHarness,
    type UiTestHarness,
} from "@vrtmrz/obsidian-plugin-kit/testing";
import { RESTORE_CONFIRMATION_INTERACTION_ID } from "../../src/restoreConfirmation.ts";

/** Result supplied by a DiffZip restore-confirmation test scenario. */
export type RestoreConfirmationDecision = "restore" | "cancel" | null;

/** Creates an App-free harness for one DiffZip restore-confirmation request. */
export function createRestoreConfirmationHarness(decision: RestoreConfirmationDecision): UiTestHarness {
    return createUiTestHarness([
        {
            kind: "confirmAction",
            interactionId: RESTORE_CONFIRMATION_INTERACTION_ID,
            value: decision,
        },
    ]);
}
