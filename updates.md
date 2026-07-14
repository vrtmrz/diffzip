# Updates

## Unreleased

### New features

- Backup, restore, and selective-sync operations now request a best-effort screen wake lock on supported devices. The request is released when the operation completes, is cancelled, or fails.

### Improved

- Restore completion now waits for every selected archive file to finish writing before completion is reported and the screen wake lock is released.
