import { svelte } from "@sveltejs/vite-plugin-svelte";
import { svelteTesting } from "@testing-library/svelte/vite";
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
    plugins: [svelte(), svelteTesting()],
    resolve: {
        alias: {
            obsidian: fileURLToPath(new URL("./tests/ui/obsidianMock.ts", import.meta.url)),
        },
    },
    test: {
        environment: "jsdom",
        include: ["tests/ui/**/*.test.ts"],
    },
});
