import {
    createScreenWakeLockManager,
    type ScreenWakeLockManager,
    type ScreenWakeLockManagerOptions,
} from "octagonal-wheels/browser/wakeLock";

export type DiffZipWakeLockLabel =
    | "archive-restore"
    | "differential-backup"
    | "selective-sync-fetch"
    | "selective-sync-send";

export type DiffZipWakeLock = Pick<ScreenWakeLockManager, "dispose" | "run">;

export function createDiffZipWakeLock(options: ScreenWakeLockManagerOptions = {}): ScreenWakeLockManager {
    return createScreenWakeLockManager(options);
}

export function runWithDiffZipWakeLock<T>(
    wakeLock: DiffZipWakeLock,
    label: DiffZipWakeLockLabel,
    task: () => T | PromiseLike<T>
): Promise<T> {
    return wakeLock.run(task, { label });
}
