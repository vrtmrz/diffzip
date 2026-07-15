import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("version bump records a release when minAppVersion is unchanged", async (context) => {
    const fixture = await mkdtemp(join(tmpdir(), "diffzip-version-bump-"));
    context.after(() => rm(fixture, { recursive: true, force: true }));

    await copyFile(new URL("../../version-bump.mjs", import.meta.url), join(fixture, "version-bump.mjs"));
    await writeFile(join(fixture, "manifest.json"), JSON.stringify({ version: "0.1.9", minAppVersion: "1.8.7" }));
    await writeFile(join(fixture, "versions.json"), JSON.stringify({ "0.1.9": "1.8.7" }));

    const result = spawnSync(process.execPath, ["version-bump.mjs"], {
        cwd: fixture,
        encoding: "utf8",
        env: { ...process.env, npm_package_version: "0.1.10-mirror.1" },
    });
    assert.equal(result.status, 0, result.stderr);

    const manifest = JSON.parse(await readFile(join(fixture, "manifest.json"), "utf8"));
    const versions = JSON.parse(await readFile(join(fixture, "versions.json"), "utf8"));
    assert.equal(manifest.version, "0.1.10-mirror.1");
    assert.equal(versions["0.1.10-mirror.1"], "1.8.7");
});
