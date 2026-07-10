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
    "restore-files",
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

## Fancy Kit previews

Until the Fancy Kit packages are published to npm, `package.json` pins the required preview tarballs from one GitHub pre-release. Update all Fancy Kit URLs together. The plug-in kit declares an exact dependency on the matching `@vrtmrz/ui-interactions@0.1.0` preview, and the lockfile records each tarball integrity hash.
