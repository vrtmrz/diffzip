<script lang="ts">
    import { onDestroy } from "svelte";
    import type DiffZipBackupPlugin from "../main.ts";
    import type { FileInfos } from "./types.ts";
    import { LATEST } from "./restoreConstants.ts";

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
        onApply: (_selectedRevisions: Record<string, number>, _mode: RestoreMode, _prefix: string) => Promise<void>;
        onCancel: () => void;
    }

    let { toc, onApply, onCancel }: Props = $props();

    // svelte-ignore state_referenced_locally
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
            .sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }))
    );

    let searchInput = $state("");
    let searchDebounced = $state("");
    let showUnselected = $state(true);
    let applying = $state(false);
    let mode = $state<RestoreMode>("new");
    let prefix = $state("");
    let restorePoint = $state(0);

    let searchTimeoutId: number | undefined = undefined;
    function handleSearchInput(e: Event) {
        const target = e.target as HTMLInputElement;
        searchInput = target.value;
        if (searchTimeoutId !== undefined) {
            window.clearTimeout(searchTimeoutId);
        }
        searchTimeoutId = window.setTimeout(() => {
            searchDebounced = searchInput;
        }, 300);
    }

    onDestroy(() => {
        if (searchTimeoutId !== undefined) {
            window.clearTimeout(searchTimeoutId);
        }
    });

    interface TreeNode {
        id: string; // The path (e.g. folder/subfolder or folder/subfolder/file.md)
        name: string; // Basename of folder or file
        type: "folder" | "file";
        level: number;
        children: TreeNode[];
        row?: Row;
    }

    const tree = $derived.by(() => {
        const rootNodes: TreeNode[] = [];
        const nodeMap = new Map<string, TreeNode>();

        for (const row of rows) {
            const parts = row.filename.split("/");
            let currentPath = "";
            let parent: TreeNode | null = null;

            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];
                const isLast = i === parts.length - 1;
                if (currentPath) {
                    currentPath += "/" + part;
                } else {
                    currentPath = part;
                }

                let node = nodeMap.get(currentPath);
                if (!node) {
                    node = {
                        id: currentPath,
                        name: part,
                        type: isLast ? "file" : "folder",
                        level: i,
                        children: [],
                        row: isLast ? row : undefined,
                    };
                    nodeMap.set(currentPath, node);

                    if (parent) {
                        parent.children.push(node);
                    } else {
                        rootNodes.push(node);
                    }
                }
                parent = node;
            }
        }
        return rootNodes;
    });

    let expandedFolders = $state<Set<string>>(new Set<string>());

    function toggleFolderExpand(id: string) {
        if (expandedFolders.has(id)) {
            expandedFolders.delete(id);
        } else {
            expandedFolders.add(id);
        }
        expandedFolders = new Set(expandedFolders);
    }

    function expandAll() {
        const allFolders = new Set<string>();
        const traverse = (n: TreeNode) => {
            if (n.type === "folder") {
                allFolders.add(n.id);
                n.children.forEach(traverse);
            }
        };
        tree.forEach(traverse);
        expandedFolders = allFolders;
    }

    function collapseAll() {
        expandedFolders = new Set<string>();
    }

    function getFolderSelectionState(node: TreeNode): "checked" | "unchecked" | "indeterminate" {
        const getFiles = (n: TreeNode): Row[] => {
            if (n.type === "file") {
                return [n.row!];
            }
            return n.children.flatMap(getFiles);
        };
        const files = getFiles(node);
        if (files.length === 0) return "unchecked";
        const selectedCount = files.filter((f) => f.selected !== 0).length;
        if (selectedCount === 0) return "unchecked";
        if (selectedCount === files.length) return "checked";
        return "indeterminate";
    }

    function toggleFolder(node: TreeNode, checked: boolean) {
        const targetVal = checked ? LATEST : 0;
        const setFiles = (n: TreeNode) => {
            if (n.type === "file") {
                if (n.row) {
                    n.row.selected = targetVal;
                }
            } else {
                for (const child of n.children) {
                    setFiles(child);
                }
            }
        };
        setFiles(node);
    }

    function getFolderFileCount(node: TreeNode): number {
        const getCount = (n: TreeNode): number => {
            if (n.type === "file") return 1;
            return n.children.reduce((acc, child) => acc + getCount(child), 0);
        };
        return getCount(node);
    }

    const visibleNodes = $derived.by(() => {
        const list: TreeNode[] = [];
        const q = searchDebounced.trim().toLowerCase();

        const matchesQuery = (node: TreeNode): boolean => {
            if (node.type === "file") {
                if (!showUnselected && node.row!.selected === 0) {
                    return false;
                }
                if (!q) return true;
                const row = node.row!;
                return (
                    row.filename.toLowerCase().includes(q) ||
                    row.latestZip.toLowerCase().includes(q) ||
                    row.latestModified.toLowerCase().includes(q)
                );
            }
            return node.children.some((child) => matchesQuery(child));
        };

        const traverse = (node: TreeNode) => {
            if (!matchesQuery(node)) {
                return;
            }

            list.push(node);

            const isExpanded = q ? true : expandedFolders.has(node.id);
            if (node.type === "folder" && isExpanded) {
                for (const child of node.children) {
                    traverse(child);
                }
            }
        };

        for (const node of tree) {
            traverse(node);
        }
        return list;
    });

    const selectedCount = $derived(rows.filter((r) => r.selected !== 0).length);

    const restorePoints = $derived.by(() => {
        const points = new Map<number, string>();
        for (const row of rows) {
            for (const rev of row.history) {
                if (!Number.isFinite(rev.ts)) continue;
                points.set(rev.ts, rev.modified);
            }
        }
        return [...points.entries()]
            .map(([ts, modified]) => ({ ts, modified }))
            .sort((a, b) => b.ts - a.ts);
    });

    function setSelected(filename: string, selected: number) {
        const row = rows.find((r) => r.filename === filename);
        if (row) {
            row.selected = selected;
        }
    }

    function rowMatchesCurrentFilter(row: Row): boolean {
        if (!showUnselected && row.selected === 0) {
            return false;
        }
        const q = searchDebounced.trim().toLowerCase();
        if (!q) return true;
        return (
            row.filename.toLowerCase().includes(q) ||
            row.latestZip.toLowerCase().includes(q) ||
            row.latestModified.toLowerCase().includes(q)
        );
    }

    function selectLatest(targetRows: Row[]) {
        for (const r of targetRows) {
            const targetVal = r.history.length > 0 ? LATEST : 0;
            if (r.selected !== targetVal) {
                r.selected = targetVal;
            }
        }
    }

    function selectAllLatest() {
        selectLatest(rows);
    }

    function selectFilteredLatest() {
        selectLatest(rows.filter(rowMatchesCurrentFilter));
    }

    function filteredRows(): Row[] {
        return rows.filter(rowMatchesCurrentFilter);
    }

    function selectFilteredAtRestorePoint() {
        selectRowsAtRestorePoint(filteredRows());
    }

    function selectAllAtRestorePoint() {
        selectRowsAtRestorePoint(rows);
    }

    function selectRowsAtRestorePoint(targetRows: Row[]) {
        if (restorePoint === 0) return;
        for (const row of targetRows) {
            const revision = row.history.find((rev) => rev.ts <= restorePoint);
            row.selected = revision?.ts ?? 0;
        }
    }

    function clearSelection() {
        for (const r of rows) {
            if (r.selected !== 0) {
                r.selected = 0;
            }
        }
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
            rows.filter((r) => r.selected !== 0).map((r) => [r.filename, r.selected] as const)
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
            <input type="text" placeholder="filename / zip / date" value={searchInput} oninput={handleSearchInput} />
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
                {#each visibleNodes as node (node.id)}
                    {#if node.type === "folder"}
                        <tr class="diffzip-folder-row" style="padding-left: {node.level * 1.5 + 0.6}em;">
                            <td class="col-check">
                                <input
                                    type="checkbox"
                                    checked={getFolderSelectionState(node) === "checked"}
                                    indeterminate={getFolderSelectionState(node) === "indeterminate"}
                                    onchange={(e) => toggleFolder(node, (e.target as HTMLInputElement).checked)}
                                />
                            </td>
                            <td class="col-path">
                                <button
                                    class="diffzip-tree-toggle"
                                    onclick={() => toggleFolderExpand(node.id)}
                                    aria-label={expandedFolders.has(node.id) ? "Collapse" : "Expand"}
                                >
                                    {expandedFolders.has(node.id) ? "▼" : "▶"}
                                </button>
                                <span class="diffzip-tree-icon">📁</span>
                                <span class="diffzip-tree-name">{node.name}</span>
                                <span class="diffzip-tree-count">({getFolderFileCount(node)})</span>
                            </td>
                            <td class="col-zip"></td>
                            <td class="col-mod"></td>
                            <td class="col-rev"></td>
                        </tr>
                    {:else}
                        {@const row = node.row!}
                        <tr style="padding-left: {node.level * 1.5 + 0.6}em;">
                            <td class="col-check">
                                <input
                                    type="checkbox"
                                    checked={row.selected !== 0}
                                    onchange={(e) =>
                                        setSelected(row.filename, (e.target as HTMLInputElement).checked ? LATEST : 0)}
                                />
                            </td>
                            <td class="col-path">
                                <span class="diffzip-tree-icon">📄</span>
                                <span class="diffzip-tree-name">{node.name}</span>
                            </td>
                            <td class="col-zip">{row.latestZip || "—"}</td>
                            <td class="col-mod">{formatDate(row.latestModified)}</td>
                            <td class="col-rev">
                                {#if row.history.length === 0}
                                    <span class="diffzip-restore-empty">No revisions</span>
                                {:else}
                                    <select
                                        value={row.selected}
                                        onchange={(e) =>
                                            setSelected(
                                                row.filename,
                                                Number.parseInt((e.target as HTMLSelectElement).value)
                                            )}
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
                    {/if}
                {/each}
            </tbody>
        </table>
    </div>

    <div class="diffzip-sync-buttons">
        <button onclick={clearSelection}>Clear</button>
        <button onclick={selectFilteredLatest}>Select Filtered Latest</button>
        <button onclick={selectAllLatest}>Select All Latest</button>
        <button onclick={selectFilteredAtRestorePoint} disabled={restorePoint === 0}>Select Filtered at Point</button>
        <button onclick={selectAllAtRestorePoint} disabled={restorePoint === 0}>Select All at Point</button>
        <button onclick={expandAll}>Expand All</button>
        <button onclick={collapseAll}>Collapse All</button>
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
        <label>
            Restore point
            <select bind:value={restorePoint}>
                <option value={0}>Latest</option>
                {#each restorePoints as point}
                    <option value={point.ts}>{formatDate(point.modified)}</option>
                {/each}
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
