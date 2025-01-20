<script lang="ts">
	import type DiffZipBackupPlugin from "./main";
	import type { FileInfos } from "./main";
	import { type ListOperations } from "./RestoreView";
	import RestoreFileInfo from "./RestoreFileInfo.svelte";
	import type { Writable } from "svelte/store";
	let test = $state("");
	interface Props {
		plugin: DiffZipBackupPlugin;
		toc: FileInfos;
		fileList: Writable<string[]>;
		selectedTimestamp: Writable<Record<string, number>>;
	}
	let {
		plugin,
		toc = $bindable(),
		fileList,
		selectedTimestamp,
	}: Props = $props();
	const files = $derived(
		$fileList.sort((a, b) =>
			a.localeCompare(b, undefined, { numeric: true }),
		),
	);
	const allFiles = $derived(Object.keys(toc));
	function clearList() {
		fileList.set([]);
	}
	function expandFolder(name: string, preventRender = false) {
		const folderPrefix = name.slice(0, -1);
		const files = allFiles.filter((e) => e.startsWith(folderPrefix));
		const newFiles = [...new Set([...$fileList, ...files])].filter(
			(e) => e !== name,
		);
		fileList.set(newFiles);
	}

	function expandAll() {
		const folders = $fileList.filter((e) => e.endsWith("*"));
		for (const folder of folders) {
			expandFolder(folder, true);
		}
	}

	function remove(file: string) {
		fileList.set($fileList.filter((e) => e !== file));
	}
	function fileSelected(file: string, timestamp: number) {
		selectedTimestamp.update((ts) => {
			if (timestamp === 0) {
				delete ts[file];
			} else {
				ts[file] = timestamp;
			}
			return ts;
		});
	}
	const commands: ListOperations = {
		clearList,
		expandFolder,
		expandAll,
		remove,
		fileSelected,
	};
</script>

<div class="diff-zip-files">
	{#if files}
		{#each files as file (file)}
			<RestoreFileInfo
				{commands}
				{plugin}
				{toc}
				filename={file}
				selected={$selectedTimestamp?.[file] ?? 0}
			/>
		{/each}
	{/if}
</div>
