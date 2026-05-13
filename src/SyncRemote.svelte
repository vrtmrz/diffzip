<script lang="ts">
	import type { SyncItem, SyncOperation } from "./SyncRemoteDialog.ts";

	interface Props {
		initialItems: SyncItem[];
		onApply: (items: SyncItem[]) => Promise<void>;
		onCancel: () => void;
	}

	let { initialItems, onApply, onCancel }: Props = $props();

	let items = $state<SyncItem[]>(initialItems.map((i) => ({ ...i })));
	let showSame = $state(false);
	let applying = $state(false);

	const visibleItems = $derived(
		showSame ? items : items.filter((i) => i.operation !== "Same"),
	);

	const opClass: Record<SyncOperation, string> = {
		Add: "op-add",
		Update: "op-update",
		Revert: "op-revert",
		Conflict: "op-conflict",
		Delete: "op-delete",
		Extra: "op-extra",
		Same: "op-same",
	};

	function toggle(filename: string) {
		items = items.map((i) =>
			i.filename === filename ? { ...i, checked: !i.checked } : i,
		);
	}

	function clear() {
		items = items.map((i) => ({ ...i, checked: false }));
	}

	function synchroniseEdits() {
		items = items.map((i) => ({
			...i,
			checked: ["Add", "Update", "Delete"].includes(i.operation),
		}));
	}

	function timetravelAll() {
		items = items.map((i) => ({
			...i,
			checked: i.operation !== "Same" && i.operation !== "Conflict",
		}));
	}

	function clearDeletion() {
		items = items.map((i) =>
			["Delete", "Extra"].includes(i.operation)
				? { ...i, checked: false }
				: i,
		);
	}

	async function handleApply() {
		applying = true;
		const checked = items.filter((i) => i.checked);
		await onApply(checked);
		applying = false;
	}

	function formatDate(modified: string): string {
		if (!modified) return "—";
		try {
			return new Date(modified).toLocaleString();
		} catch {
			return modified;
		}
	}
</script>

<div class="diffzip-sync-dialog">
	<div class="diffzip-sync-table-wrap">
		<table class="diffzip-sync-table">
			<thead>
				<tr>
					<th class="col-check">✓</th>
					<th class="col-path">File Path</th>
					<th class="col-op">Operation</th>
					<th class="col-zip">ZIP File</th>
					<th class="col-mod">Modified</th>
				</tr>
			</thead>
			<tbody>
				{#each visibleItems as item (item.filename)}
					<tr class:op-same-row={item.operation === "Same"}>
						<td class="col-check">
							{#if item.operation !== "Same"}
								<input
									type="checkbox"
									checked={item.checked}
									onchange={() => toggle(item.filename)}
								/>
							{/if}
						</td>
						<td class="col-path">{item.filename}</td>
						<td class="col-op">
							<span class="op-badge {opClass[item.operation]}"
								>{item.operation}</span
							>
						</td>
						<td class="col-zip">{item.zipName || "—"}</td>
						<td class="col-mod">{formatDate(item.modified)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>

	<div class="diffzip-sync-controls">
		<label>
			<input type="checkbox" bind:checked={showSame} />
			Show Same Files
		</label>
	</div>

	<div class="diffzip-sync-buttons">
		<button onclick={clear}>Clear</button>
		<button onclick={synchroniseEdits}>Synchronise Edits</button>
		<button onclick={timetravelAll}>Timetravel</button>
		<button onclick={clearDeletion}>Clear Deletion</button>
	</div>

	<div class="diffzip-sync-footer">
		<button onclick={onCancel} disabled={applying}>Cancel</button>
		<button class="mod-cta" onclick={handleApply} disabled={applying}>
			{applying ? "Applying..." : "Apply"}
		</button>
	</div>
</div>
