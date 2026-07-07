import { render, screen, waitFor, within } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import RestoreRevisionDialog from "../../src/RestoreRevisionDialog.svelte";
import { LATEST } from "../../src/restoreConstants.ts";
import type { FileInfos } from "../../src/types.ts";

const olderVisible = Date.parse("2024-01-01T00:00:00.000Z");
const restorePoint = Date.parse("2024-02-01T00:00:00.000Z");
const newerVisible = Date.parse("2024-03-01T00:00:00.000Z");
const hiddenRevision = Date.parse("2024-01-15T00:00:00.000Z");
const rootRevision = Date.parse("2024-01-20T00:00:00.000Z");
const futureOnlyRevision = Date.parse("2024-04-01T00:00:00.000Z");

function history(zipName: string, modified: string) {
    return {
        zipName,
        modified,
        digest: zipName,
    };
}

function createToc(): FileInfos {
    return {
        "folder/visible.md": {
            filename: "folder/visible.md",
            digest: "visible",
            mtime: newerVisible,
            history: [
                history("visible-new.zip", "2024-03-01T00:00:00.000Z"),
                history("visible-restore-point.zip", "2024-02-01T00:00:00.000Z"),
                history("visible-old.zip", "2024-01-01T00:00:00.000Z"),
            ],
        },
        "folder/hidden.md": {
            filename: "folder/hidden.md",
            digest: "hidden",
            mtime: hiddenRevision,
            history: [history("hidden.zip", "2024-01-15T00:00:00.000Z")],
        },
        "root.md": {
            filename: "root.md",
            digest: "root",
            mtime: rootRevision,
            history: [history("root.zip", "2024-01-20T00:00:00.000Z")],
        },
        "future.md": {
            filename: "future.md",
            digest: "future",
            mtime: futureOnlyRevision,
            history: [history("future.zip", "2024-04-01T00:00:00.000Z")],
        },
    };
}

function renderDialog(onApply = vi.fn().mockResolvedValue(undefined)) {
    render(RestoreRevisionDialog, {
        props: {
            plugin: {},
            toc: createToc(),
            onApply,
            onCancel: vi.fn(),
        },
    });
    return onApply;
}

describe("RestoreRevisionDialog", () => {
    it("selects only filtered files at the selected restore point", async () => {
        const user = userEvent.setup();
        const onApply = renderDialog();

        await user.type(screen.getByPlaceholderText("filename / zip / date"), "visible");
        await waitFor(() => expect(screen.queryByText("root.md")).toBeNull());
        expect(screen.queryByText("hidden.md")).toBeNull();
        expect(screen.queryByText("future.md")).toBeNull();

        await user.selectOptions(screen.getByLabelText("Restore point"), String(restorePoint));
        await user.click(screen.getByRole("button", { name: "Select Filtered at Point" }));
        await user.click(screen.getByRole("button", { name: "Restore" }));

        await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
        expect(onApply).toHaveBeenCalledWith(
            {
                "folder/visible.md": restorePoint,
            },
            "new",
            ""
        );
    });

    it("selects the latest revision at or before the restore point", async () => {
        const user = userEvent.setup();
        const onApply = renderDialog();

        await user.selectOptions(screen.getByLabelText("Restore point"), String(restorePoint));
        await user.click(screen.getByRole("button", { name: "Select All at Point" }));

        await user.click(screen.getByRole("button", { name: "Restore" }));

        await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
        expect(onApply).toHaveBeenCalledWith(
            {
                "folder/hidden.md": hiddenRevision,
                "folder/visible.md": restorePoint,
                "root.md": rootRevision,
            },
            "new",
            ""
        );
    });

    it("does not select files with no revision at or before the restore point", async () => {
        const user = userEvent.setup();
        const onApply = renderDialog();

        await user.selectOptions(screen.getByLabelText("Restore point"), String(restorePoint));
        await user.click(screen.getByRole("button", { name: "Select All at Point" }));
        await user.click(screen.getByRole("button", { name: "Restore" }));

        await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
        expect(onApply.mock.calls[0][0]).not.toHaveProperty("future.md");
    });

    it("selects only filtered files when choosing latest revisions", async () => {
        const user = userEvent.setup();
        const onApply = renderDialog();

        await user.type(screen.getByPlaceholderText("filename / zip / date"), "visible");
        await waitFor(() => expect(screen.queryByText("root.md")).toBeNull());

        await user.click(screen.getByRole("button", { name: "Select Filtered Latest" }));
        await user.click(screen.getByRole("button", { name: "Restore" }));

        await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
        expect(onApply).toHaveBeenCalledWith(
            {
                "folder/visible.md": LATEST,
            },
            "new",
            ""
        );
    });

    it("respects Show unselected when selecting filtered restore-point revisions", async () => {
        const user = userEvent.setup();
        const onApply = renderDialog();

        await user.click(screen.getByRole("button", { name: "Select All Latest" }));
        await user.click(screen.getByLabelText("Show unselected"));
        await user.type(screen.getByPlaceholderText("filename / zip / date"), "visible");
        await waitFor(() => expect(screen.queryByText("root.md")).toBeNull());

        await user.selectOptions(screen.getByLabelText("Restore point"), String(restorePoint));
        await user.click(screen.getByRole("button", { name: "Select Filtered at Point" }));
        await user.click(screen.getByRole("button", { name: "Restore" }));

        await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
        expect(onApply).toHaveBeenCalledWith(
            {
                "folder/hidden.md": LATEST,
                "folder/visible.md": restorePoint,
                "future.md": LATEST,
                "root.md": LATEST,
            },
            "new",
            ""
        );
    });

    it("clears the current selection", async () => {
        const user = userEvent.setup();
        renderDialog();

        await user.click(screen.getByRole("button", { name: "Select All Latest" }));
        expect((screen.getByRole("button", { name: "Restore" }) as HTMLButtonElement).disabled).toBe(false);

        await user.click(screen.getByRole("button", { name: "Clear" }));

        expect((screen.getByRole("button", { name: "Restore" }) as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByText("Selected: 0")).toBeTruthy();
    });

    it("toggles folders and expands/collapses the tree", async () => {
        const user = userEvent.setup();
        const onApply = renderDialog();

        await user.click(screen.getByRole("button", { name: "Expand All" }));
        expect(await screen.findByText("visible.md")).toBeTruthy();
        expect(screen.getByText("hidden.md")).toBeTruthy();

        const folderRow = screen.getByText("folder").closest("tr");
        expect(folderRow).not.toBeNull();
        const folderCheckbox = within(folderRow!).getByRole("checkbox");
        await user.click(folderCheckbox);
        await user.click(screen.getByRole("button", { name: "Restore" }));

        await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
        expect(onApply).toHaveBeenCalledWith(
            {
                "folder/hidden.md": LATEST,
                "folder/visible.md": LATEST,
            },
            "new",
            ""
        );

        await user.click(screen.getByRole("button", { name: "Collapse All" }));
        expect(screen.queryByText("visible.md")).toBeNull();
        expect(screen.queryByText("hidden.md")).toBeNull();
    });

    it("passes restore mode and prefix to onApply", async () => {
        const user = userEvent.setup();
        const onApply = renderDialog();

        await user.type(screen.getByPlaceholderText("filename / zip / date"), "visible");
        await waitFor(() => expect(screen.queryByText("root.md")).toBeNull());
        await user.click(screen.getByRole("button", { name: "Select Filtered Latest" }));
        await user.selectOptions(screen.getByLabelText("Restore Mode"), "all-delete");
        await user.type(screen.getByPlaceholderText("folder/"), "restored/");
        await user.click(screen.getByRole("button", { name: "Restore" }));

        await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
        expect(onApply).toHaveBeenCalledWith(
            {
                "folder/visible.md": LATEST,
            },
            "all-delete",
            "restored/"
        );
    });
});
