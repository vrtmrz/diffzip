# Real Obsidian E2E

This local-only suite installs the built DiffZip plug-in into an isolated vault and profile through `@vrtmrz/obsidian-test-session`. It is not part of the default CI gate.

The restore-confirmation scenario seeds one backup-information entry, invokes the real restore workflow, and verifies rendered Markdown, the visible Cancel action, explicit cancellation, and Escape dismissal in a real Obsidian Modal. It does not use scripted `UiInteractions` responses.

The suite is currently validated on Linux only. Set `OBSIDIAN_BINARY` and `OBSIDIAN_CLI` when the executables are outside the discovery paths inherited from the shared test-session package.

```bash
npm run check:e2e:obsidian
npm run test:e2e:obsidian:restore-confirmation
```

Set `E2E_OBSIDIAN_KEEP_VAULT=true` to preserve the temporary vault and isolated application state for debugging.
