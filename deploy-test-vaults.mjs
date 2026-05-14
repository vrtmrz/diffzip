import { cpSync, mkdirSync } from "fs";
import { resolve } from "path";

// TEST_VAULT_PATHS is loaded via --env-file=.env (Node.js 20.6+)
// Multiple paths can be separated by semicolons.
const raw = process.env.TEST_VAULT_PATHS ?? "";
const paths = raw
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean);

if (paths.length === 0) {
    console.error("TEST_VAULT_PATHS is empty");
    process.exit(1);
}

const FILES = ["main.js", "manifest.json", "styles.css"];

for (const dest of paths) {
    const destResolved = resolve(dest);
    mkdirSync(destResolved, { recursive: true });
    for (const file of FILES) {
        cpSync(file, `${destResolved}/${file}`);
        console.log(`  copied ${file} -> ${destResolved}`);
    }
}

console.log(`\nDeployed to ${paths.length} vault(s).`);
