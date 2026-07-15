# Developer guide

## Running tests

The core TypeScript test suite uses Deno:

```sh
deno task test
deno task test:coverage
```

Svelte components and App-free application UI workflows use Vitest:

```sh
npm run test:ui
npm run test:ui:watch
```

Some ZIP compatibility tests use `unzip`, `7z`, `openssl`, or Windows PowerShell `Expand-Archive` when available. Tests requiring a missing tool are skipped.

## UI interaction boundary

Application workflows request reusable UI through an instance-scoped `UiInteractions` capability. The Obsidian plug-in creates one adapter for its own lifetime:

```ts
import { Plugin } from "obsidian";
import { createObsidianUi, type UiInteractions } from "@vrtmrz/obsidian-plugin-kit/ui";

class ExamplePlugin extends Plugin {
    ui!: UiInteractions;

    async onload() {
        this.ui = createObsidianUi(this.app);
    }
}
```

Pass a stable interaction ID when a workflow requests a confirmation. Visible labels are separate from the returned action identifiers, and closing the dialog resolves to `null`:

```ts
const action = await ui.confirmAction(
    {
        title: "Restore confirmation",
        message: "Restore the selected files?",
        actions: ["restore", "cancel"] as const,
        labels: { restore: "Restore", cancel: "Cancel" },
        defaultAction: "cancel",
    },
    "restore-files"
);
```

Application-flow tests use a consumer-owned wrapper around the App-free harness to provide responses and inspect the request transcript without opening Obsidian:

```ts
const harness = createRestoreConfirmationHarness("restore");
await runRestoreFlow(harness.ui);
harness.assertDone();
```

Scripted responses belong to each harness or plug-in instance. Do not store response queues in static members or module globals.

Real Modal rendering and dismissal use the local-only Obsidian harness documented in [`test/e2e-obsidian/README.md`](../test/e2e-obsidian/README.md). The real-device scenario deliberately does not configure a scripted UI driver.

## Fancy Kit dependencies

`package.json` pins the Fancy Kit packages and `octagonal-wheels` to exact npm versions so the tested dependency set remains reproducible. Review and update the four versions together when adopting a newer contract. The plug-in kit declares an exact dependency on the matching `@vrtmrz/ui-interactions` release, and the lockfile records each package integrity hash.

## Screen wake lock

The plug-in owns one lifecycle-aware screen wake-lock manager. Differential backups, archive restore, and the Fetch and Send phases of selective sync use its closure-based runner, so normal completion, cancellation, and errors release their logical lease automatically. Overlapping and nested operations share the platform wake lock. Restore planning and execution use separate leases; confirmation dialogues do not acquire one.

The Screen Wake Lock API is best effort. Consumer workflows must continue when it is unavailable or rejected, and must not rely on it for background execution. Dispose the manager when the plug-in unloads. Keep the manager injectable through the focused helper in `src/wakeLock.ts`; App-free tests use that boundary instead of constructing the Obsidian plug-in.

## Restore confirmation boundary

Restore confirmation deliberately presents the paths and operations planned at a point in time; it is not a transactional lock on the Vault. DiffZip does not revalidate deletion candidates after opening the confirmation dialogue. A caller that permits concurrent Vault changes must cancel the operation and prepare a new restore plan when the reviewed state may no longer be current.
