<script lang="ts">
	import type DiffZipBackupPlugin from "../main.ts";
	import type { FileInfos } from "./types.ts";
	import { LATEST } from "./RestoreView.ts";

	type RestoreMode = "new" | "all" | "all-delete";
	type Row = {
		filename: string;
		history: { zipName: string; modified: string; ts: number }[];
		latestZip: string;
		latestModified: string;
		selected: number;
	};

	interface Props {
		plugin: DiffZipBackupPlugin;
		toc: FileInfos;
		onApply: (
			_selectedRevisions: Record<string, number>,
			_mode: RestoreMode,
			_prefix: string,
		) => Promise<void>;
		onCancel: () => void;
	}

	let { toc, onApply, onCancel }: Props = $props();

	let rows = $state<Row[]>(
		Object.entries(toc)
			.map(([filename, fileInfo]) => {
				const history = [...(fileInfo.history ?? [])]
					.map((h) => ({
						zipName: h.zipName,
						modified: h.modified,
						ts: new Date(h.modified).getTime(),
					}))
					.sort((a, b) => b.ts - a.ts);
				const latest = history[0];
				return {
					filename,
					history,
					latestZip: latest?.zipName ?? "",
					latestModified: latest?.modified ?? "",
					selected: 0,
				} as Row;
			})
			.sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true })),
	);

	let search = $state("");
	let showUnselected = $state(true);
	let applying = $state(false);
	let mode = $state<RestoreMode>("new");
	let prefix = $state("");

	const visibleRows = $derived.by(() => {
		const q = search.trim().toLowerCase();
		return rows.filter((r) => {
			if (!showUnselected && r.selected === 0) return false;
			if (!q) return true;
			return (
				r.filename.toLowerCase().includes(q) ||
				r.latestZip.toLowerCase().includes(q) ||
				r.latestModified.toLowerCase().includes(q)
			);
		});
	});

	const selectedCount = $derived(rows.filter((r) => r.selected !== 0).length);

	function setSelected(filename: string, selected: number) {
		rows = rows.map((r) => (r.filename === filename ? { ...r, selected } : r));
	}

	function selectAllLatest() {
		rows = rows.map((r) => ({
			...r,
			selected: r.history.length > 0 ? LATEST : 0,
		}));
	}

	function selectFilteredLatest() {
		const names = new Set(visibleRows.map((r) => r.filename));
		rows = rows.map((r) => {
			if (!names.has(r.filename)) return r;
			return { ...r, selected: r.history.length > 0 ? LATEST : 0 };
		});
	}

	function clearSelection() {
		rows = rows.map((r) => ({ ...r, selected: 0 }));
	}

	function formatDate(v: string) {
		if (!v) return "—";
		try {
			return new Date(v).toLocaleString();
		} catch {
			return v;
		}
	}

	async function applyRestore() {
		const selected = Object.fromEntries(
			rows.filter((r) => r.selected !== 0).map((r) => [r.filename, r.selected] as const),
		);
		applying = true;
		try {
			await onApply(selected, mode, prefix);
		} finally {
			applying = false;
		}
	}
</script>

<div class="diffzip-sync-dialog">
	<div class="diffzip-sync-controls diffzip-restore-controls">
		<label class="diffzip-restore-search">
			<span>Search</span>
			<input type="text" placeholder="filename / zip / date" bind:value={search} />
		</label>
		<label>
			<input type="checkbox" bind:checked={showUnselected} />
			Show unselected
		</label>
		<span class="diffzip-restore-selected-count">Selected: {selectedCount}</span>
	</div>

	<div class="diffzip-sync-table-wrap">
		<table class="diffzip-sync-table diffzip-restore-table">
			<thead>
				<tr>
					<th class="col-check">Restore</th>
					<th class="col-path">File Path</th>
					<th class="col-zip">Latest ZIP</th>
					<th class="col-mod">Latest Modified</th>
					<th class="col-rev">Revision</th>
				</tr>
			</thead>
			<tbody>
				{#each visibleRows as row (row.filename)}
					<tr>
						<td class="col-check">
							<input
								type="checkbox"
								checked={row.selected !== 0}
								onchange={(e) => setSelected(row.filename, (e.target as HTMLInputElement).checked ? LATEST : 0)}
							/>
						</td>
						<td class="col-path">{row.filename}</td>
						<td class="col-zip">{row.latestZip || "—"}</td>
						<td class="col-mod">{formatDate(row.latestModified)}</td>
						<td class="col-rev">
							{#if row.history.length === 0}
								<span class="diffzip-restore-empty">No revisions</span>
							{:else}
								<select
									value={row.selected}
									onchange={(e) =>
										setSelected(row.filename, Number.parseInt((e.target as HTMLSelectElement).value))}
								>
									<option value={0}>Skip</option>
									<option value={LATEST}>Latest</option>
									{#each row.history as rev}
										<option value={rev.ts}>{rev.zipName} ({formatDate(rev.modified)})</option>
									{/each}
								</select>
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>

	<div class="diffzip-sync-buttons">
		<button onclick={clearSelection}>Clear</button>
		<button onclick={selectFilteredLatest}>Select Filtered Latest</button>
		<button onclick={selectAllLatest}>Select All Latest</button>
	</div>

	<div class="diffzip-sync-controls diffzip-restore-options">
		<label>
			Restore Mode
			<select bind:value={mode}>
				<option value="new">Only new</option>
				<option value="all">All</option>
				<option value="all-delete">All and delete extra</option>
			</select>
		</label>
		<label class="diffzip-restore-prefix">
			Additional prefix
			<input type="text" bind:value={prefix} placeholder="folder/" />
		</label>
	</div>

	<div class="diffzip-sync-footer">
		<button onclick={onCancel} disabled={applying}>Cancel</button>
		<button class="mod-cta" onclick={applyRestore} disabled={applying || selectedCount === 0}>
			{applying ? "Restoring..." : "Restore"}
		</button>
	</div>
</div>
