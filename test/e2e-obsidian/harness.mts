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

/** A running real-Obsidian DiffZip test session and its isolated vault. */
export interface DiffZipTestSession {
    /** Loaded plug-in session. */
    session: ObsidianPluginSession;
    /** Isolated vault and profile state. */
    vault: TemporaryVault;
}

async function seedRestorePlan(vaultPath: string): Promise<void> {
    const backupPath = join(vaultPath, "backup");
    await mkdir(backupPath, { recursive: true });
    const toc = {
        "notes/restore-me.md": {
            filename: "notes/restore-me.md",
            digest: "preview-digest",
            history: [
                {
                    zipName: "backup-1.zip",
                    modified: "2026-07-10T00:00:00.000Z",
                    digest: "preview-digest",
                },
            ],
            mtime: Date.parse("2026-07-10T00:00:00.000Z"),
        },
    };
    await writeFile(join(backupPath, "backupinfo.md"), `\`\`\`\n${JSON.stringify(toc)}\n\`\`\`\n`);
}

/** Starts DiffZip in an isolated real-Obsidian session with one planned restore. */
export async function startDiffZipTestSession(): Promise<DiffZipTestSession> {
    const cli = discoverObsidianCli();
    if (!cli.binary) throw new Error(`Could not find obsidian-cli. Checked: ${cli.checked.join(", ")}`);
    const vault = await createTemporaryVault({
        prefix: "diffzip-e2e-",
        pluginIds: [DIFFZIP_PLUGIN_ID],
        idPrefix: "diffzip-e2e",
    });
    try {
        await seedRestorePlan(vault.path);
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
