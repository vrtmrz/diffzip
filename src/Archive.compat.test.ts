/**
 * ZIP compatibility tests.
 *
 * Builds a real ZIP with Archiver and verifies it can be extracted by
 * tools that would be available in a typical environment:
 *
 *   - unzip  (Linux / macOS built-in; Git for Windows includes it)
 *   - 7z
 *   - openssl enc + 7z
 *   - PowerShell Expand-Archive  (Windows OS built-in)
 *
 * Tests skip gracefully when the required tool is not in PATH.
 */

// Polyfill: Archive.ts uses window.setTimeout / activeWindow
if (typeof window === "undefined") {
    (globalThis as unknown as Record<string, unknown>).window = globalThis;
    (globalThis as unknown as Record<string, unknown>).activeWindow = globalThis;
}

import { OpenSSLCompat } from "octagonal-wheels/encryption";
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
const ENCRYPTION_PASSPHRASE = "diffzip compatibility test passphrase";

async function buildZip(): Promise<Uint8Array<ArrayBuffer>> {
    const zip = new Archiver();
    for (const { name, content } of TEST_FILES) {
        zip.addTextFile(content, name, { mtime: FIXED_MTIME });
    }
    return zip.finalize();
}

async function buildEncryptedZip(): Promise<Uint8Array<ArrayBuffer>> {
    const zipData = await buildZip();
    const encrypted = await OpenSSLCompat.CBC.encryptCBC(zipData, ENCRYPTION_PASSPHRASE, 10000);
    return new Uint8Array(encrypted) as Uint8Array<ArrayBuffer>;
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

function splitBytes(data: Uint8Array<ArrayBuffer>, chunkSize: number): Uint8Array<ArrayBuffer>[] {
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    for (let offset = 0; offset < data.length; offset += chunkSize) {
        chunks.push(data.slice(offset, offset + chunkSize));
    }
    return chunks;
}

function concatBytes(chunks: Uint8Array<ArrayBuffer>[]): Uint8Array<ArrayBuffer> {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        joined.set(chunk, offset);
        offset += chunk.length;
    }
    return joined as Uint8Array<ArrayBuffer>;
}

function extractedPath(tmpDir: string, name: string): string {
    return Deno.build.os === "windows"
        ? `${tmpDir}\\${name.replace(/\//g, "\\")}`
        : `${tmpDir}/${name}`;
}

async function assertExtractedFiles(tmpDir: string): Promise<void> {
    for (const { name, content } of TEST_FILES) {
        const bytes = await Deno.readFile(extractedPath(tmpDir, name));
        const actual = text(bytes);
        if (actual !== content) {
            throw new Error(
                `Content mismatch for ${name}:\n` +
                    `  expected ${JSON.stringify(content)}\n` +
                    `  got      ${JSON.stringify(actual)}`,
            );
        }
    }
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
        await assertExtractedFiles(tmpDir);
    } finally {
        await Deno.remove(tmpZip).catch(() => {});
        await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    }
});

// ── 7z ────────────────────────────────────────────────────────────────────────

Deno.test("ZIP compat: 7z extracts files with correct content", async () => {
    if (!(await commandExists("7z"))) {
        console.log("  (skip) 7z not found in PATH");
        return;
    }
    const tmpZip = await Deno.makeTempFile({ suffix: ".zip" });
    const tmpDir = await Deno.makeTempDir();
    try {
        await Deno.writeFile(tmpZip, await buildZip());
        const r = await new Deno.Command("7z", {
            args: ["x", "-y", `-o${tmpDir}`, tmpZip],
            stdout: "piped",
            stderr: "piped",
        }).output();
        if (!r.success) {
            throw new Error(`7z extract failed:\n${text(r.stdout)}\n${text(r.stderr)}`);
        }
        await assertExtractedFiles(tmpDir);
    } finally {
        await Deno.remove(tmpZip).catch(() => {});
        await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    }
});

// ── Split ZIP chunks ──────────────────────────────────────────────────────────

Deno.test("ZIP compat: split ZIP chunks can be joined and extracted by 7z", async () => {
    if (!(await commandExists("7z"))) {
        console.log("  (skip) 7z not found in PATH");
        return;
    }
    const tmpZip = await Deno.makeTempFile({ suffix: ".zip" });
    const tmpDir = await Deno.makeTempDir();
    try {
        const zipData = await buildZip();
        const chunks = splitBytes(zipData, Math.max(1, Math.floor(zipData.length / 3)));
        if (chunks.length < 2) {
            throw new Error("Test setup failed: ZIP should be split into multiple chunks");
        }
        await Deno.writeFile(tmpZip, concatBytes(chunks));
        const r = await new Deno.Command("7z", {
            args: ["x", "-y", `-o${tmpDir}`, tmpZip],
            stdout: "piped",
            stderr: "piped",
        }).output();
        if (!r.success) {
            throw new Error(`7z extract of joined split ZIP failed:\n${text(r.stdout)}\n${text(r.stderr)}`);
        }
        await assertExtractedFiles(tmpDir);
    } finally {
        await Deno.remove(tmpZip).catch(() => {});
        await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    }
});

// ── OpenSSL-compatible encryption ─────────────────────────────────────────────

Deno.test("ZIP compat: openssl decrypts encrypted ZIP and 7z extracts it", async () => {
    if (!(await commandExists("openssl"))) {
        console.log("  (skip) openssl not found in PATH");
        return;
    }
    if (!(await commandExists("7z"))) {
        console.log("  (skip) 7z not found in PATH");
        return;
    }
    const tmpEncrypted = await Deno.makeTempFile({ suffix: ".zip.enc" });
    const tmpZip = await Deno.makeTempFile({ suffix: ".zip" });
    const tmpDir = await Deno.makeTempDir();
    try {
        await Deno.writeFile(tmpEncrypted, await buildEncryptedZip());
        const decrypt = await new Deno.Command("openssl", {
            args: [
                "enc",
                "-d",
                "-aes-256-cbc",
                "-in",
                tmpEncrypted,
                "-out",
                tmpZip,
                "-k",
                ENCRYPTION_PASSPHRASE,
                "-pbkdf2",
                "-md",
                "sha256",
            ],
            stdout: "piped",
            stderr: "piped",
        }).output();
        if (!decrypt.success) {
            throw new Error(`openssl decrypt failed:\n${text(decrypt.stdout)}\n${text(decrypt.stderr)}`);
        }

        const extract = await new Deno.Command("7z", {
            args: ["x", "-y", `-o${tmpDir}`, tmpZip],
            stdout: "piped",
            stderr: "piped",
        }).output();
        if (!extract.success) {
            throw new Error(
                `7z extract after openssl decrypt failed:\n${text(extract.stdout)}\n${text(extract.stderr)}`,
            );
        }
        await assertExtractedFiles(tmpDir);
    } finally {
        await Deno.remove(tmpEncrypted).catch(() => {});
        await Deno.remove(tmpZip).catch(() => {});
        await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    }
});

Deno.test("ZIP compat: openssl decrypts encrypted split chunks and 7z extracts the joined ZIP", async () => {
    if (!(await commandExists("openssl"))) {
        console.log("  (skip) openssl not found in PATH");
        return;
    }
    if (!(await commandExists("7z"))) {
        console.log("  (skip) 7z not found in PATH");
        return;
    }

    const tmpDir = await Deno.makeTempDir();
    const tmpZip = await Deno.makeTempFile({ suffix: ".zip" });
    const extractDir = await Deno.makeTempDir();
    const encryptedPartPaths: string[] = [];
    const decryptedPartPaths: string[] = [];
    try {
        const zipData = await buildZip();
        const chunks = splitBytes(zipData, Math.max(1, Math.floor(zipData.length / 3)));
        if (chunks.length < 2) {
            throw new Error("Test setup failed: ZIP should be split into multiple chunks");
        }

        for (let i = 0; i < chunks.length; i++) {
            const encrypted = await OpenSSLCompat.CBC.encryptCBC(chunks[i], ENCRYPTION_PASSPHRASE, 10000);
            const encryptedPath = `${tmpDir}/part-${i}.enc`;
            const decryptedPath = `${tmpDir}/part-${i}.zipchunk`;
            encryptedPartPaths.push(encryptedPath);
            decryptedPartPaths.push(decryptedPath);
            await Deno.writeFile(encryptedPath, new Uint8Array(encrypted) as Uint8Array<ArrayBuffer>);

            const decrypt = await new Deno.Command("openssl", {
                args: [
                    "enc",
                    "-d",
                    "-aes-256-cbc",
                    "-in",
                    encryptedPath,
                    "-out",
                    decryptedPath,
                    "-k",
                    ENCRYPTION_PASSPHRASE,
                    "-pbkdf2",
                    "-md",
                    "sha256",
                ],
                stdout: "piped",
                stderr: "piped",
            }).output();
            if (!decrypt.success) {
                throw new Error(`openssl decrypt split chunk failed:\n${text(decrypt.stdout)}\n${text(decrypt.stderr)}`);
            }
        }

        const decryptedChunks = [];
        for (const path of decryptedPartPaths) {
            decryptedChunks.push(await Deno.readFile(path));
        }
        await Deno.writeFile(tmpZip, concatBytes(decryptedChunks));

        const extract = await new Deno.Command("7z", {
            args: ["x", "-y", `-o${extractDir}`, tmpZip],
            stdout: "piped",
            stderr: "piped",
        }).output();
        if (!extract.success) {
            throw new Error(
                `7z extract after decrypting split chunks failed:\n${text(extract.stdout)}\n${text(extract.stderr)}`,
            );
        }
        await assertExtractedFiles(extractDir);
    } finally {
        await Deno.remove(tmpZip).catch(() => {});
        for (const path of encryptedPartPaths) await Deno.remove(path).catch(() => {});
        for (const path of decryptedPartPaths) await Deno.remove(path).catch(() => {});
        await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
        await Deno.remove(extractDir, { recursive: true }).catch(() => {});
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
            await assertExtractedFiles(tmpDir);
        } finally {
            await Deno.remove(tmpZip).catch(() => {});
            await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
        }
    },
);
