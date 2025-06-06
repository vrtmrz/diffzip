<script lang="ts">
	import DiffZipBackupPlugin from "./main";
	import type { FileInfos } from "types";
	import { LATEST, type ListOperations } from "./RestoreView";

	interface Props {
		plugin: DiffZipBackupPlugin;
		toc: FileInfos;
		filename: string;
		commands: ListOperations;

		selected: number;
	}
	let {
		toc = $bindable(),
		filename = $bindable(),
		commands = $bindable(),
		selected = $bindable(),
	}: Props = $props();

	const isFolder = $derived(filename.endsWith("*"));
	const relatedFiles = $derived(
		isFolder
			? Object.keys(toc).filter((f) =>
					f.startsWith(filename.slice(0, -1)),
				)
			: [filename],
	);
	const relatedFilesInfo = $derived(relatedFiles.map((f) => toc[f]));
	const timeStamps = $derived(
		[
			...new Set(
				relatedFilesInfo
					.map((f) =>
						f.history.map((e) => new Date(e.modified).getTime()),
					)
					.flat(),
			),
		].sort((a, b) => b - a),
	);

	let selectedTimestamp = $state(0);
</script>

<div class="diffzip-list-row">
	<span class="diffzip-list-file">
		<span class="title">{filename}</span>
		{#if isFolder}
			<span class="filecount">({relatedFiles.length})</span>
		{/if}
	</span>
	<span class="diffzip-list-timestamp">
		{#if timeStamps.length === 0}
			<span class="empty">No Timestamp</span>
		{:else}
			<select
				class="dropdown"
				onchange={(e) =>
					commands.fileSelected(
						filename,
						Number.parseInt((e.target as HTMLSelectElement)?.value),
					)}
				value={selected}
			>
				<option value={LATEST}>Latest</option>
				{#each timeStamps as ts}
					<option value={ts}>{new Date(ts).toLocaleString()}</option>
				{/each}
				<option value={0}> - </option>
			</select>
		{/if}
	</span>
	<span class="diffzip-list-actions">
		{#if isFolder}
			<button
				title="Expand Folder"
				onclick={() => commands.expandFolder(filename)}
			>
				📂
			</button>
		{/if}
		<button onclick={() => commands.remove(filename)}> 🗑️ </button>
	</span>
</div>

<style>
	select {
		height: var(--input-height);
	}
	.diffzip-list-row {
		display: flex;
		flex-direction: row;
		flex-wrap: wrap;
		flex-grow: 1;
		min-height: 2em;
		padding: 2px 0;
	}

	.diffzip-list-row > span:not(:last-child) {
		margin-right: 4px;
	}
	.diffzip-list-file {
		flex-grow: 1;
		word-break: break-all;
		margin-bottom: 0.25em;
		margin-top: 0.25em;
	}
	.diffzip-list-timestamp {
		margin-left: auto;
	}
	.diffzip-list-actions {
		word-wrap: none;
		word-break: keep-all;
	}
</style>
