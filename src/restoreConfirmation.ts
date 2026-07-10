import type { UiInteractions } from "@vrtmrz/obsidian-plugin-kit/ui";

/** Stable identifier used to script and trace the restore confirmation. */
export const RESTORE_CONFIRMATION_INTERACTION_ID = "restore-files";

/** Describes the files and deletion records presented before a restore. */
export interface RestoreConfirmationOptions {
    /** Number of files that will be restored. */
    processFileCount: number;
    /** Restored file paths grouped by their source ZIP name. */
    filesByZip: ReadonlyMap<string, readonly string[]>;
    /** Whether deletion records should be presented to the user. */
    deleteMissing: boolean;
    /** Local file paths represented by applicable deletion records. */
    deletingFiles: readonly string[];
}

/** Requests confirmation for a planned restore through the injected UI capability. */
export async function confirmRestore(
    ui: UiInteractions,
    { processFileCount, filesByZip, deleteMissing, deletingFiles }: RestoreConfirmationOptions,
): Promise<boolean> {
    const detailFiles = `<details>

${[...filesByZip.entries()]
    .map(([zipName, files]) => `${files.map((file) => `- ${file}  (${zipName})`).join("\n")}\n`)
    .sort((a, b) => a.localeCompare(b))
    .join("")}


</details>`;
    const detailDeletedFiles = `<details>

${deletingFiles.map((file) => `- ${file}`).join("\n")}

</details>`;
    const deleteMessage =
        deleteMissing && deletingFiles.length > 0
            ? `And ${deletingFiles.length} files will be deleted.\n${detailDeletedFiles}\n`
            : "";
    const message = `We have ${processFileCount} files to restore on ${filesByZip.size} ZIPs. \n${detailFiles}\n${deleteMessage}Are you sure to proceed?`;

    const action = await ui.confirmAction(
        {
            title: "Restore Confirmation",
            message,
            actions: ["restore", "cancel"] as const,
            labels: {
                restore: "Yes, restore them!",
                cancel: "Cancel",
            },
            defaultAction: "cancel",
            sourcePath: "/",
        },
        RESTORE_CONFIRMATION_INTERACTION_ID,
    );
    return action === "restore";
}
