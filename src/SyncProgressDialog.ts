import { Modal, type App } from "obsidian";

type SyncProgressDialogOptions = {
    title: string;
    content: DocumentFragment;
    onCancel: () => void;
};

export class SyncProgressDialog extends Modal {
    private readonly options: SyncProgressDialogOptions;
    private cancelButton?: HTMLButtonElement;
    private footerMessageEl?: HTMLDivElement;
    private finished = false;
    private cancelRequested = false;

    constructor(app: App, options: SyncProgressDialogOptions) {
        super(app);
        this.options = options;
    }

    onOpen() {
        const { contentEl } = this;
        this.titleEl.setText(this.options.title);
        contentEl.empty();

        const wrapper = contentEl.createDiv({ cls: "diffzip-sync-progress-dialog" });

        wrapper.appendChild(this.options.content);

        const footer = wrapper.createDiv({ cls: "diffzip-sync-progress-footer" });

        this.footerMessageEl = footer.createDiv({ cls: "diffzip-sync-progress-message" });

        const buttonRow = footer.createDiv({ cls: "diffzip-sync-progress-buttons" });

        this.cancelButton = buttonRow.createEl("button", { text: "Stop" });
        this.cancelButton.type = "button";
        this.cancelButton.addEventListener("click", () => {
            if (this.finished) {
                this.close();
                return;
            }
            this.requestCancel();
        });
    }

    requestCancel() {
        if (this.cancelRequested || this.finished) return;
        this.cancelRequested = true;
        if (this.cancelButton) {
            this.cancelButton.disabled = true;
            this.cancelButton.textContent = "Stopping...";
        }
        this.setFooterMessage("Stopping...");
        this.options.onCancel();
    }

    setFooterMessage(message: string) {
        if (this.footerMessageEl) {
            this.footerMessageEl.textContent = message;
        }
    }

    finish(message: string) {
        if (this.finished) return;
        this.finished = true;
        if (this.cancelButton) {
            this.cancelButton.disabled = false;
            this.cancelButton.textContent = "Close";
        }
        this.setFooterMessage(message);
    }

    onClose() {
        super.onClose();
        if (!this.finished && !this.cancelRequested) {
            this.requestCancel();
        }
        this.contentEl.empty();
    }
}