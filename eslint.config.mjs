import tsParser from "@typescript-eslint/parser";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { defineConfig, globalIgnores } from "eslint/config";
import * as sveltePlugin from "eslint-plugin-svelte";
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
                // projectService: {
                //     allowDefaultProject: ["eslint.config.js", "manifest.json"],
                // },
                tsconfigRootDir: import.meta.dirname,
                extraFileExtensions: [".json"],
            },
        },
        rules: {
            "obsidianmd/no-plugin-as-component": "off", // Temporary
            "obsidianmd/rule-custom-message": "off", // Temporary
            "obsidianmd/ui/sentence-case": "off", // Temporary
            "obsidianmd/no-static-styles-assignment": "warn", // Temporary
            "obsidianmd/settings-tab/no-manual-html-headings": "warn", // Temporary
        },
    },
    {
        files: ["**/*.svelte"],
        languageOptions: {
            parserOptions: {
                parser: tsParser,
            },
        },
        rules: {
            "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
            "obsidianmd/no-plugin-as-component": "off", // Temporary
        },
    },
]);
