export type SyncOperation =
    | "Add"
    | "Updated"
    | "Old"
    | "Conflict"
    | "Delete"
    | "Extra (Delete)"
    | "Same";

export type SyncAction = "None" | "Fetch" | "Send";

export type PlannerOptions = {
    destructiveDefaultsEnabled: boolean;
};

export function getAllowedActions(operation: SyncOperation): SyncAction[] {
    if (operation === "Same") return ["None"];
    if (operation === "Add") return ["None", "Fetch"];
    if (operation === "Extra (Delete)") return ["None", "Send"];
    return ["None", "Fetch", "Send"];
}

export function isActionAllowed(operation: SyncOperation, action: SyncAction): boolean {
    return getAllowedActions(operation).includes(action);
}

export function getDefaultAction(operation: SyncOperation, options: PlannerOptions): SyncAction {
    switch (operation) {
        case "Add":
        case "Updated":
            return "Fetch";
        case "Old":
            return "Send";
        case "Delete":
            return options.destructiveDefaultsEnabled ? "Fetch" : "None";
        case "Extra (Delete)":
            return options.destructiveDefaultsEnabled ? "Send" : "None";
        case "Conflict":
        case "Same":
        default:
            return "None";
    }
}

export type SendFileCandidate = {
    filename: string;
    size: number;
};

export type SendBatch = {
    files: SendFileCandidate[];
    totalSize: number;
};

export function planSendBatches(
    candidates: SendFileCandidate[],
    maxFilesInZip: number,
    maxTotalSizeInZip: number,
): { batches: SendBatch[]; oversizedFiles: string[] } {
    const batches: SendBatch[] = [];
    const oversizedFiles: string[] = [];

    let current: SendBatch = { files: [], totalSize: 0 };

    const flush = () => {
        if (current.files.length > 0) {
            batches.push(current);
            current = { files: [], totalSize: 0 };
        }
    };

    for (const file of candidates) {
        if (maxTotalSizeInZip > 0 && file.size > maxTotalSizeInZip) {
            // File is too large for a single ZIP, but include it anyway
            // Flush current batch first
            flush();
            // Create a solo batch for this oversized file
            batches.push({ files: [file], totalSize: file.size });
            oversizedFiles.push(file.filename);
            continue;
        }

        const exceedsFileCount = maxFilesInZip > 0 && current.files.length >= maxFilesInZip;
        const exceedsTotalSize =
            maxTotalSizeInZip > 0 &&
            current.files.length > 0 &&
            current.totalSize + file.size > maxTotalSizeInZip;

        if (exceedsFileCount || exceedsTotalSize) {
            flush();
        }

        current.files.push(file);
        current.totalSize += file.size;
    }

    flush();

    return { batches, oversizedFiles };
}

export type TocHistory = {
    zipName: string;
    modified: string;
    missing?: boolean;
    processed?: number;
    digest: string;
};

export type TocEntry = {
    filename: string;
    digest: string;
    history: TocHistory[];
    mtime: number;
    processed?: number;
    missing?: boolean;
};

export type TocMap = Record<string, TocEntry>;

export type TocUpdate =
    | {
          kind: "file";
          filename: string;
          digest: string;
          mtime: number;
      }
    | {
          kind: "missing";
          filename: string;
          modifiedTime: number;
      };

export type SyncItem = {
    filename: string;
    operation: SyncOperation;
    zipName: string;
    modified: string;
    action: SyncAction;
    allowedActions: SyncAction[];
    defaultAction: SyncAction;
};

export type BuildSyncItemsOptions = {
    destructiveDefaultsEnabled: boolean;
    pluginDir?: string;
    ignoreHidden?: boolean;
    ignorePatterns?: string[];
};

export function buildSyncItems(
    remoteToc: TocMap,
    localFileMap: Map<string, { digest: string; mtime: number }>,
    options: BuildSyncItemsOptions,
): SyncItem[] {
    const { destructiveDefaultsEnabled, pluginDir, ignoreHidden = false, ignorePatterns = [] } = options;

    const shouldIgnore = (filename: string): boolean => {
        if (pluginDir && filename.startsWith(pluginDir)) return true;
        if (!ignoreHidden) return false;
        for (const pattern of ignorePatterns) {
            if (filename === pattern || filename.startsWith(pattern + "/")) return true;
        }
        if (filename.split("/").some((part) => part.startsWith("."))) return true;
        return false;
    };

    const items: SyncItem[] = [];

    for (const [filename, fileInfo] of Object.entries(remoteToc)) {
        if (shouldIgnore(filename)) continue;

        const history = [...fileInfo.history].sort(
            (a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime(),
        );
        if (history.length === 0) continue;
        const latest = history[0];
        const isRemoteMissing = fileInfo.missing === true;
        const localInfo = localFileMap.get(filename);

        let operation: SyncOperation | undefined;

        if (isRemoteMissing) {
            if (localInfo) operation = "Delete";
        } else if (!localInfo) {
            operation = "Add";
        } else if (latest.digest === localInfo.digest) {
            operation = "Same";
        } else {
            const remoteMtime = new Date(latest.modified).getTime();
            if (remoteMtime > localInfo.mtime) operation = "Updated";
            else if (remoteMtime < localInfo.mtime) operation = "Old";
            else operation = "Conflict";
        }

        if (operation) {
            const allowedActions = getAllowedActions(operation);
            const defaultAction = getDefaultAction(operation, { destructiveDefaultsEnabled });
            const action = isActionAllowed(operation, defaultAction) ? defaultAction : "None";
            items.push({ filename, operation, zipName: latest.zipName, modified: latest.modified, action, allowedActions, defaultAction });
        }
    }

    // Extra: local files not in remote TOC
    for (const filename of localFileMap.keys()) {
        if (shouldIgnore(filename)) continue;
        if (!(filename in remoteToc)) {
            const operation: SyncOperation = "Extra (Delete)";
            const allowedActions = getAllowedActions(operation);
            const defaultAction = getDefaultAction(operation, { destructiveDefaultsEnabled });
            const action = isActionAllowed(operation, defaultAction) ? defaultAction : "None";
            items.push({ filename, operation, zipName: "", modified: "", action, allowedActions, defaultAction });
        }
    }

    return items;
}

export function applySendBatchToToc(
    toc: TocMap,
    updates: TocUpdate[],
    zipName: string,
    processedAt: number,
): TocMap {
    const next: TocMap = { ...toc };

    for (const update of updates) {
        const existing = next[update.filename];
        const existingHistory = existing?.history ?? [];

        if (update.kind === "file") {
            next[update.filename] = {
                filename: update.filename,
                digest: update.digest,
                mtime: update.mtime,
                processed: processedAt,
                missing: false,
                history: [
                    ...existingHistory,
                    {
                        zipName,
                        modified: new Date(update.mtime).toISOString(),
                        processed: processedAt,
                        digest: update.digest,
                    },
                ],
            };
            continue;
        }

        next[update.filename] = {
            filename: update.filename,
            digest: "",
            mtime: update.modifiedTime,
            processed: processedAt,
            missing: true,
            history: [
                ...existingHistory,
                {
                    zipName,
                    modified: new Date(update.modifiedTime).toISOString(),
                    missing: true,
                    processed: processedAt,
                    digest: "",
                },
            ],
        };
    }

    return next;
}
