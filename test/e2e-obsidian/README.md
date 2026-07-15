# Real Obsidian E2E

This local-only suite installs the built DiffZip plug-in into an isolated vault and profile through `@vrtmrz/obsidian-test-session`. It is not part of the default CI gate.

The restore-confirmation scenario seeds 60 restore entries across three ZIPs and 24 local files represented by mirror deletion records. It invokes the real normal-restore and delete-missing confirmation paths, verifies their rendered Markdown summaries and boundary paths, expands the long file lists, and checks explicit cancellation and Escape dismissal in a real Obsidian Modal. At a fixed phone viewport, the public test-session assertions require the title, Close control, and action row to respect supplied safe-area insets, prevent horizontal overflow in the expanded content and action row, and require 44 CSS-pixel Close, Restore, and Cancel touch targets. It does not use scripted `UiInteractions` responses.

The wake-lock scenario creates a Vault fixture, invokes the real differential-backup entry point, removes the original, and restores it from the generated ZIP. It verifies that one logical wake-lock lease is active and released for both operations, confirms that the fixture reached `backupinfo.md`, and checks the restored content. Platform support is collected as evidence rather than required on desktop. Physical display behaviour for backup, restore, and selective sync remains a manual mobile review.

The suite is currently validated on Linux only. Set `OBSIDIAN_BINARY` and `OBSIDIAN_CLI` when the executables are outside the discovery paths inherited from the shared test-session package.

```bash
npm run check:e2e:obsidian
npm run test:e2e:obsidian:restore-confirmation
npm run test:e2e:obsidian:wake-lock
```

Set `E2E_OBSIDIAN_KEEP_VAULT=true` to preserve the temporary vault and isolated application state for debugging.
