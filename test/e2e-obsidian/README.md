# Real Obsidian E2E

This local-only suite installs the built DiffZip plug-in into an isolated vault and profile through `@vrtmrz/obsidian-test-session`. It is not part of the default CI gate.

The restore-confirmation scenario seeds 60 restore entries across three ZIPs and 24 local files represented by mirror deletion records. It invokes the real normal-restore and delete-missing confirmation paths, verifies their rendered Markdown summaries and boundary paths, expands the long file lists, and checks explicit cancellation and Escape dismissal in a real Obsidian Modal. At a fixed phone viewport, the public test-session assertions require the title, Close control, and action row to respect supplied safe-area insets, prevent horizontal overflow in the expanded content and action row, and require 44 CSS-pixel Close, Restore, and Cancel touch targets. It does not use scripted `UiInteractions` responses.

The mirror-delete-semantics scenario opens the real revision selector and verifies that 'All and delete extra' enables deletion without enabling new-files-only mode. It verifies that the selected historical revision, rather than the current TOC state, decides whether a file is restored or deleted. Missing and unreadable archives, missing ZIP entries, and Vault write failures must reject the restore and preserve deletion candidates. Planning and execution each hold one wake-lock lease, while the confirmation wait holds none. The final large-fixture pass observes the extraction plan without reading fixture ZIPs, verifies that no deletion record is sent for extraction, and verifies that all 24 applicable local files are removed through the active Vault storage accessor.

The legacy-folder-restore scenario selects a restore point containing both an ordinary revision and a deletion record through the real legacy prompt sequence. It verifies that the ordinary file is restored without treating the contentless deletion record as a ZIP extraction request.

The wake-lock scenario creates a Vault fixture, invokes the real differential-backup entry point, removes the original, and restores it from the generated ZIP. It verifies that one logical wake-lock lease is active and released for both operations, confirms that the fixture reached `backupinfo.md`, and checks the restored content. Platform support is collected as evidence rather than required on desktop. Physical display behaviour for backup, restore, and selective sync remains a manual mobile review.

The suite is currently validated on Linux only. Set `OBSIDIAN_BINARY` and `OBSIDIAN_CLI` when the executables are outside the discovery paths inherited from the shared test-session package.

```bash
npm run check:e2e:obsidian
npm run test:e2e:obsidian:restore-confirmation
npm run test:e2e:obsidian:legacy-folder-restore
npm run test:e2e:obsidian:mirror-delete-semantics
npm run test:e2e:obsidian:wake-lock
```

Set `E2E_OBSIDIAN_KEEP_VAULT=true` to preserve the temporary vault and isolated application state for debugging.
