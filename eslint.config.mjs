import tsParser from "@typescript-eslint/parser";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { defineConfig, globalIgnores } from "eslint/config";
import * as sveltePlugin from "eslint-plugin-svelte";
import svelteParser from "svelte-eslint-parser";
import { baseRules, obsidianRules } from "./eslint.config.common.mjs";

export default defineConfig([
    globalIgnores([
        "node_modules",
        "data.json",
        "dist",
        "esbuild.config.mjs",
        "eslint.config.js",
        "version-bump.mjs",
        "versions.json",
        "main.js",
        "**/*.test.ts",
    ]),
    {
        linterOptions: {
            reportUnusedDisableDirectives: "off",
        },
    },
    ...sveltePlugin.configs["flat/base"],
    ...obsidianmd.configs.recommended,
    {
        files: ["**/*.ts"],
        languageOptions: {
            globals: {
                ...globals.browser,
            },
            parser: tsParser,
            parserOptions: {
                project: "./tsconfig.json",
                tsconfigRootDir: import.meta.dirname,
                extraFileExtensions: [".json"],
            },
        },
        rules: {
            ...baseRules,
            ...obsidianRules,
            // Custom rules overrides or adjustments for diffzip:
            "obsidianmd/no-plugin-as-component": "off",
            "obsidianmd/rule-custom-message": "off",
            "obsidianmd/ui/sentence-case": "off",
            "obsidianmd/no-static-styles-assignment": "off",
        },
    },
    {
        files: ["**/*.svelte"],
        languageOptions: {
            globals: {
                ...globals.browser,
            },
            parser: svelteParser,
            parserOptions: {
                parser: tsParser,
                extraFileExtensions: [".svelte"],
            },
        },
        rules: {
            "no-unused-vars": "off",
            ...obsidianRules,
            "obsidianmd/no-plugin-as-component": "off",
            "obsidianmd/no-unsupported-api": "off",
        },
    },
]);
