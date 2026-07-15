import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
    createTemporaryVault,
    discoverObsidianCli,
    requireObsidianBinary,
    startObsidianPluginSession,
    type ObsidianPluginSession,
    type TemporaryVault,
} from "@vrtmrz/obsidian-test-session";

export const DIFFZIP_PLUGIN_ID = "diffzip";
export const RESTORE_FIXTURE_ZIP_COUNT = 3;
export const RESTORE_FIXTURE_PATHS = Array.from({ length: 60 }, (_, index) => {
    const ordinal = String(index + 1).padStart(3, "0");
    return `notes/restore/batch/restore-${ordinal}-with-a-deliberately-long-file-name-for-mobile-layout-review.md`;
});
export const MIRROR_DELETION_FIXTURE_PATHS = Array.from({ length: 24 }, (_, index) => {
    const ordinal = String(index + 1).padStart(3, "0");
    return `mirror/obsolete-${ordinal}.md`;
});

interface RestoreTocEntry {
    filename: string;
    digest: string;
    history: Array<{
        zipName: string;
        modified: string;
        digest: string;
    }>;
    mtime: number;
    missing?: boolean;
}

/** A running real-Obsidian DiffZip test session and its isolated vault. */
export interface DiffZipTestSession {
    /** Loaded plug-in session. */
    session: ObsidianPluginSession;
    /** Isolated vault and profile state. */
    vault: TemporaryVault;
}

export interface StartDiffZipTestSessionOptions {
    /** Restore plan fixture to seed before Obsidian starts. Defaults to the original single-file plan. */
    restorePlan?: "single" | "large";
}

async function writeRestorePlan(vaultPath: string, toc: Record<string, RestoreTocEntry>): Promise<void> {
    const backupPath = join(vaultPath, "backup");
    await mkdir(backupPath, { recursive: true });
    await writeFile(join(backupPath, "backupinfo.md"), `\`\`\`\n${JSON.stringify(toc)}\n\`\`\`\n`);
}

async function seedSingleRestorePlan(vaultPath: string): Promise<void> {
    const filename = "notes/restore-me.md";
    const modified = "2026-07-10T00:00:00.000Z";
    const digest = "preview-digest";
    await writeRestorePlan(vaultPath, {
        [filename]: {
            filename,
            digest,
            history: [{ zipName: "backup-1.zip", modified, digest }],
            mtime: Date.parse(modified),
        },
    });
}

async function seedLargeRestorePlan(vaultPath: string): Promise<void> {
    const mirrorPath = join(vaultPath, "mirror");
    await mkdir(mirrorPath, { recursive: true });
    const modified = "2026-07-10T00:00:00.000Z";
    const toc: Record<string, RestoreTocEntry> = {};
    for (const [index, filename] of RESTORE_FIXTURE_PATHS.entries()) {
        const digest = `restore-digest-${index + 1}`;
        toc[filename] = {
            filename,
            digest,
            history: [
                {
                    zipName: `backup-${(index % RESTORE_FIXTURE_ZIP_COUNT) + 1}.zip`,
                    modified,
                    digest,
                },
            ],
            mtime: Date.parse(modified),
        };
    }
    for (const [index, filename] of MIRROR_DELETION_FIXTURE_PATHS.entries()) {
        const digest = `missing-digest-${index + 1}`;
        toc[filename] = {
            filename,
            digest,
            history: [
                {
                    zipName: "backup-mirror.zip",
                    modified,
                    digest,
                },
            ],
            mtime: Date.parse(modified),
            missing: true,
        };
        await writeFile(join(vaultPath, filename), `Local mirror candidate ${index + 1}`);
    }
    await writeRestorePlan(vaultPath, toc);
}

/** Starts DiffZip in an isolated real-Obsidian session with the selected restore plan fixture. */
export async function startDiffZipTestSession(
    { restorePlan = "single" }: StartDiffZipTestSessionOptions = {},
): Promise<DiffZipTestSession> {
    const cli = discoverObsidianCli();
    if (!cli.binary) throw new Error(`Could not find obsidian-cli. Checked: ${cli.checked.join(", ")}`);
    const vault = await createTemporaryVault({
        prefix: "diffzip-e2e-",
        pluginIds: [DIFFZIP_PLUGIN_ID],
        idPrefix: "diffzip-e2e",
    });
    try {
        if (restorePlan === "large") {
            await seedLargeRestorePlan(vault.path);
        } else {
            await seedSingleRestorePlan(vault.path);
        }
        const session = await startObsidianPluginSession({
            binary: requireObsidianBinary(),
            cliBinary: cli.binary,
            vault,
            pluginId: DIFFZIP_PLUGIN_ID,
            artifactRoot: resolve("."),
            startupGraceMs: Number(process.env.E2E_OBSIDIAN_STARTUP_GRACE_MS ?? 1_000),
        });
        return { session, vault };
    } catch (error) {
        await vault.dispose();
        throw error;
    }
}

/** Stops Obsidian and removes the isolated DiffZip test state. */
export async function stopDiffZipTestSession(testSession: DiffZipTestSession): Promise<void> {
    await testSession.session.app.stop();
    await testSession.vault.dispose();
}
