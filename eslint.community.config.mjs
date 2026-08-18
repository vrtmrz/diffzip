import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig(
    globalIgnores([
        "node_modules",
        "dist",
        "coverage",
        "main.js",
        "package.json",
        "package-lock.json",
        "versions.json",
        "**/*.svelte",
        "**/*.test.ts",
        "test/**",
    ]),
    {
        languageOptions: {
            globals: {
                ...globals.browser,
            },
            parserOptions: {
                project: "./tsconfig.json",
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },
    ...obsidianmd.configs.recommended,
    {
        rules: {
            // The directory review reports console usage as guidance rather than a release blocker.
            "obsidianmd/rule-custom-message": "off",
            "no-console": "warn",
            // Keep existing type-safety debt visible while reserving errors for directory-review blockers.
            "@typescript-eslint/no-unsafe-argument": "warn",
            "@typescript-eslint/no-unsafe-assignment": "warn",
            "@typescript-eslint/no-unsafe-call": "warn",
            "@typescript-eslint/no-unsafe-member-access": "warn",
            "@typescript-eslint/no-unsafe-return": "warn",
            "@typescript-eslint/no-base-to-string": "warn",
            "@typescript-eslint/no-redundant-type-constituents": "warn",
            "@typescript-eslint/no-unnecessary-type-assertion": "warn",
        },
    }
);
