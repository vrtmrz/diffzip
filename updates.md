# Updates

## 0.1.10

### Fixed

- `All and delete extra` now restores the selected files successfully before deleting local files represented by the selected deletion records.
- Restore-point decisions now use the state of the selected historical revision, including files deleted or recreated later.
- Missing archives, missing ZIP entries, unreadable archives, Vault write failures, and deletion failures are now reported instead of being treated as successful restoration.
- The legacy folder restore skips deletion records and restores the available file revisions.

### Improved

- A restore that will delete local files now uses an explicit `Restore and Delete Confirmation` title and `Restore and delete` action, with `Cancel` as the default.
- Restore planning and execution use separate screen wake-lock leases, so reviewing the confirmation does not keep the screen awake.

## 0.1.9

### New features

- Backup, restore, and selective-sync operations now request a best-effort screen wake lock on supported devices. The request is released when the operation completes, is cancelled, or fails.

### Improved

- Restore completion now waits for every selected archive file to finish writing before completion is reported and the screen wake lock is released.
