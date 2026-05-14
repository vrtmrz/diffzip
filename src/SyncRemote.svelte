<script lang="ts">
	import type { SyncAction, SyncItem, SyncOperation } from "./SyncRemoteDialog.ts";

	interface Props {
		initialItems: SyncItem[];
		onApply: (_items: SyncItem[]) => Promise<void>;
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
		Updated: "op-updated",
		Old: "op-old",
		Conflict: "op-conflict",
		Delete: "op-delete",
		"Extra (Delete)": "op-extra",
		Same: "op-same",
	};

	function setAction(filename: string, action: SyncAction) {
		items = items.map((i) =>
			i.filename === filename ? { ...i, action } : i,
		);
	}

	function clear() {
		items = items.map((i) => ({ ...i, action: "None" }));
	}

	function fetchAll() {
		items = items.map((i) => ({
			...i,
			action: i.allowedActions.includes("Fetch") ? "Fetch" : "None",
		}));
	}

	function sendAll() {
		items = items.map((i) => ({
			...i,
			action: i.allowedActions.includes("Send") ? "Send" : "None",
		}));
	}

	function sync() {
		items = items.map((i) => ({
			...i,
			action: i.defaultAction,
		}));
	}

	function syncWithDeletion() {
		items = items.map((i) => {
			// For Delete/Extra operations, force their default destructive actions
			if (i.operation === "Delete" || i.operation === "Extra (Delete)") {
				const action = i.operation === "Delete" ? "Fetch" : "Send";
				return {
					...i,
					action: i.allowedActions.includes(action) ? action : "None",
				};
			}
			// For other operations, use defaultAction
			return {
				...i,
				action: i.defaultAction,
			};
		});
	}

	async function handleApply() {
		applying = true;
		await onApply(items);
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
					<th class="col-check">Action</th>
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
							<fieldset class="action-radio-group">
								{#each item.allowedActions as action}
									<label class="action-radio">
										<input
											type="radio"
											name={`action-${item.filename}`}
											value={action}
											checked={item.action === action}
											onchange={() => setAction(item.filename, action)}
										/>
										<span class="action-emoji" title={action}>
											{action === "None" ? "⊘" : action === "Fetch" ? "⬇️" : "⬆️"}
										</span>
									</label>
								{/each}
							</fieldset>
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
		<button onclick={sync}>Sync</button>
		<button onclick={syncWithDeletion}>Sync W/ deletion</button>
		<button onclick={fetchAll}>Fetch All</button>
		<button onclick={sendAll}>Send All</button>
	</div>

	<div class="diffzip-sync-footer">
		<button onclick={onCancel} disabled={applying}>Cancel</button>
		<button class="mod-cta" onclick={handleApply} disabled={applying}>
			{applying ? "Applying..." : "Apply"}
		</button>
	</div>
</div>
