/**
 * ZIP compatibility tests.
 *
 * Builds a real ZIP with Archiver and verifies it can be extracted by
 * tools that would be available in a typical environment:
 *
 *   - unzip  (Linux / macOS built-in; Git for Windows includes it)
 *   - PowerShell Expand-Archive  (Windows OS built-in)
 *
 * Tests skip gracefully when the required tool is not in PATH.
 */

// Polyfill: Archive.ts uses window.setTimeout / activeWindow
if (typeof window === "undefined") {
    (globalThis as unknown as Record<string, unknown>).window = globalThis;
    (globalThis as unknown as Record<string, unknown>).activeWindow = globalThis;
}

import { Archiver } from "./Archive.ts";

declare const Deno: {
    test: (name: string, fn: () => Promise<void>) => void;
    build: { os: string };
    makeTempFile: (options?: { suffix?: string }) => Promise<string>;
    makeTempDir: () => Promise<string>;
    writeFile: (path: string, data: Uint8Array<ArrayBuffer>) => Promise<void>;
    readFile: (path: string) => Promise<Uint8Array<ArrayBuffer>>;
    remove: (path: string, options?: { recursive?: boolean }) => Promise<void>;
    Command: new (
        cmd: string,
        options?: {
            args?: string[];
            stdout?: "piped" | "null" | "inherit";
            stderr?: "piped" | "null" | "inherit";
        },
    ) => {
        output: () => Promise<{
            success: boolean;
            stdout: Uint8Array<ArrayBuffer>;
            stderr: Uint8Array<ArrayBuffer>;
        }>;
    };
};

// ── Test fixtures ─────────────────────────────────────────────────────────────

/** Files that will be packed into the test ZIP. */
const TEST_FILES = [
    { name: "hello.txt", content: "Hello, World!\n" },
    { name: "subdir/note.md", content: "# Heading\n\nContent line.\n" },
    { name: "data.json", content: '{"key":"value","num":42}\n' },
] as const;

/** Fixed mtime in the fflate-valid range (2024-06-01 00:00 UTC). */
const FIXED_MTIME = new Date("2024-06-01T00:00:00Z").getTime();

async function buildZip(): Promise<Uint8Array<ArrayBuffer>> {
    const zip = new Archiver();
    for (const { name, content } of TEST_FILES) {
        zip.addTextFile(content, name, { mtime: FIXED_MTIME });
    }
    return zip.finalize();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function commandExists(cmd: string): Promise<boolean> {
    const [checker, arg] =
        Deno.build.os === "windows" ? ["where", cmd] : ["which", cmd];
    try {
        const r = await new Deno.Command(checker, {
            args: [arg],
            stdout: "null",
            stderr: "null",
        }).output();
        return r.success;
    } catch {
        return false;
    }
}

function text(bytes: Uint8Array<ArrayBuffer>): string {
    return new TextDecoder().decode(bytes);
}

// ── unzip ─────────────────────────────────────────────────────────────────────

Deno.test("ZIP compat: unzip -t integrity check", async () => {
    if (!(await commandExists("unzip"))) {
        console.log("  (skip) unzip not found in PATH");
        return;
    }
    const tmp = await Deno.makeTempFile({ suffix: ".zip" });
    try {
        await Deno.writeFile(tmp, await buildZip());
        const r = await new Deno.Command("unzip", {
            args: ["-t", tmp],
            stdout: "piped",
            stderr: "piped",
        }).output();
        if (!r.success) {
            throw new Error(`unzip -t failed:\n${text(r.stdout)}\n${text(r.stderr)}`);
        }
    } finally {
        await Deno.remove(tmp).catch(() => {});
    }
});

Deno.test("ZIP compat: unzip extracts files with correct content", async () => {
    if (!(await commandExists("unzip"))) {
        console.log("  (skip) unzip not found in PATH");
        return;
    }
    const tmpZip = await Deno.makeTempFile({ suffix: ".zip" });
    const tmpDir = await Deno.makeTempDir();
    try {
        await Deno.writeFile(tmpZip, await buildZip());
        const r = await new Deno.Command("unzip", {
            args: ["-o", tmpZip, "-d", tmpDir],
            stdout: "piped",
            stderr: "piped",
        }).output();
        if (!r.success) {
            throw new Error(`unzip failed:\n${text(r.stdout)}\n${text(r.stderr)}`);
        }
        for (const { name, content } of TEST_FILES) {
            const bytes = await Deno.readFile(`${tmpDir}/${name}`);
            const actual = text(bytes);
            if (actual !== content) {
                throw new Error(
                    `Content mismatch for ${name}:\n` +
                        `  expected ${JSON.stringify(content)}\n` +
                        `  got      ${JSON.stringify(actual)}`,
                );
            }
        }
    } finally {
        await Deno.remove(tmpZip).catch(() => {});
        await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    }
});

// ── PowerShell Expand-Archive (Windows OS built-in) ───────────────────────────

Deno.test(
    "ZIP compat: PowerShell Expand-Archive extracts correct content (Windows)",
    async () => {
        if (Deno.build.os !== "windows") {
            console.log("  (skip) not on Windows");
            return;
        }
        const tmpZip = await Deno.makeTempFile({ suffix: ".zip" });
        const tmpDir = await Deno.makeTempDir();
        try {
            await Deno.writeFile(tmpZip, await buildZip());
            const r = await new Deno.Command("powershell", {
                args: [
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    `Expand-Archive -Path '${tmpZip}' -DestinationPath '${tmpDir}' -Force`,
                ],
                stdout: "piped",
                stderr: "piped",
            }).output();
            if (!r.success) {
                throw new Error(`Expand-Archive failed:\n${text(r.stderr)}`);
            }
            for (const { name, content } of TEST_FILES) {
                const path = `${tmpDir}\\${name.replace(/\//g, "\\")}`;
                const bytes = await Deno.readFile(path);
                const actual = text(bytes);
                if (actual !== content) {
                    throw new Error(
                        `Content mismatch for ${name}:\n` +
                            `  expected ${JSON.stringify(content)}\n` +
                            `  got      ${JSON.stringify(actual)}`,
                    );
                }
            }
        } finally {
            await Deno.remove(tmpZip).catch(() => {});
            await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
        }
    },
);
