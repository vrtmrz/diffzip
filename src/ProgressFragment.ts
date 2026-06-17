/**
 * Represents a UI fragment for displaying and controlling progress.
 * Provides properties and methods to update progress, label, note, and completion state.
 */
// deno-lint-ignore-file adjacent-overload-signatures no-window-prefix no-window
export class ProgressFragment {

    /**
     * The root DocumentFragment containing the progress UI.
     */
    _fragment: DocumentFragment;
    /**
     * The HTMLProgressElement used to display progress.
     */
    _progressEl?: HTMLProgressElement;
    /**
     * The total value for progress completion.
     */
    _total: number = 100;
    /**
     * The current progress value.
     */
    _value: number = 0;
    /**
     * The label text displayed above the progress bar.
     */
    _titleText: string = "";
    /**
     * The HTMLLabelElement for the progress label.
     */
    _titleEl?: HTMLLabelElement;
    /**
     * The HTMLSpanElement for displaying a note below the progress bar.
     */
    _noteEl?: HTMLSpanElement;
    /**
     * The HTMLSpanElement for displaying numeric progress status.
     */
    _numericStatusEl?: HTMLSpanElement;
    /**
     * The wrapper div containing all progress UI elements.
     */
    _wrapperEl?: HTMLDivElement;

    /**
     * Largest note area height observed so far.
     * Keeps note area stable even when note text becomes shorter.
     */
    _maxNoteHeight = 0;

    /**
     * The note text displayed below the progress bar.
     */
    _noteText: string = "";
    /**
     * Callback invoked when progress completes.
     */
    _onComplete?: () => void;
    /**
     * Callback invoked when progress is cancelled.
     */
    _onCancel?: () => void;
    /**
     * Callback invoked when the fragment is ready.
     */
    _onReady?: (fragment: DocumentFragment) => void;
    /**
     * Callback invoked when progress changes.
     */
    _onProgress?: () => void;

    /**
     * Formats the numeric progress text.
     */
    _formatNumeric?: (value: number, total: number, isCancelled: boolean) => string;

    /**
     * Indicates whether the progress has been cancelled.
     */
    _isCancelled = false;

    /**
     * Indicates whether the progress UI is collapsed.
     */
    _isCollapsed: boolean = false;

    /**
     * Returns true if the progress UI is currently shown.
     */
    get isShown() {
        return this._wrapperEl?.isShown() ?? false;
    }
    /**
     * Gets or sets whether the progress UI is collapsed.
     */
    get collapsed() {
        return this._isCollapsed;
    }
    set collapsed(value: boolean) {
        this._isCollapsed = value;
        if (this._wrapperEl) {
            this._wrapperEl.setCssStyles({ display: value ? "none" : "block" });
        }
    }

    /**
     * Gets or sets whether the progress has been cancelled.
     */
    get isCancelled() {
        return this._isCancelled;
    }
    set isCancelled(value: boolean) {
        this._isCancelled = value;
        this.computeNumeric();
        this.__onProgress();
    }

    /**
     * Returns true if the progress has completed.
     */
    get isCompleted() {
        return this.value != 0 && this._value >= this._total;
    }
    /**
     * Returns true if the progress has started.
     */
    get isStarted() {
        return this.value != 0 && this._total != 0;
    }

    /**
     * Gets or sets the current progress value.
     */
    get value() {
        return this._value;
    }

    /**
     * Gets or sets the maximum progress value.
     */
    get total() {
        return this._total;
    }

    /**
     * Gets or sets the label text.
     */
    get title() {
        return this._titleText;
    }


    set value(val: number) {
        this._value = val;
        if (this._progressEl) {
            this._progressEl.value = val;
        }
        this.computeNumeric();
        if (this.isCompleted && this._onComplete) {
            window.setTimeout(() => this._onComplete?.(), 10);
        }
        this.__onProgress();
    }
    set total(val: number) {
        this._total = val;
        if (this._progressEl) {
            this._progressEl.max = val;
        }
        this.computeNumeric();
        this.__onProgress();
    }

    set title(val: string) {
        this._titleText = val;
        if (this._titleEl) {
            this._titleEl.textContent = val;
        }
        this.computeMaxWidth();
        this.__onProgress();
    }

    /**
     * Gets or sets the note text.
     */
    get note() {
        return this._noteText;
    }

    set note(val: string) {
        this._noteText = val;
        if (this._noteEl) {
            this._noteEl.textContent = val;
        }
        this.computeMaxWidth();
        this.__onProgress();
    }

    /**
     * Returns the root DocumentFragment for this progress UI.
     */
    get fragment() {
        return this._fragment;
    }

    /**
     * Updates the numeric status display based on current progress.
     */
    computeNumeric() {
        if (this._numericStatusEl) {
            if (this.isCancelled) {
                this._numericStatusEl.textContent = `- / -`;
                this.computeMaxWidth();
                return;
            }
            if (this.isStarted) {
                this._numericStatusEl.textContent = this._formatNumeric
                    ? this._formatNumeric(this._value, this._total, this.isCancelled)
                    : `${this._value} / ${this._total}`;
                this.computeMaxWidth();
                return;
            }
            this._numericStatusEl.textContent = "";
        }
    }

    /**
     * Internal flag indicating if properties are being applied.
     * @internal
     */
    __isApplying = false;
    /**
     * Internal flag indicating if onProgress is being called.
     * @internal
     */
    __isOnProgress = false;
    /**
     * Invokes the onProgress callback if set.
     * @internal
     */
    __onProgress() {
        if (this.__isOnProgress) return;
        if (this.__isApplying) return;
        try {
            this.__isOnProgress = true;
            this._onProgress?.();
        } finally {
            this.__isOnProgress = false;
        }
    }

    /**
     * Minimum width of the progress UI.
     */
    minWidth = 200;
    /**
     * Minimum height of the progress UI.
     */
    minHeight = 10;
    /**
     * Computes and sets the minimum width and height of the wrapper based on content.
     */
    computeMaxWidth() {
        // Keep note area from shrinking once it has expanded.
        if (!this._noteEl) return;
        if (this._maxNoteHeight > 0) {
            this._noteEl.setCssStyles({ minHeight: `${this._maxNoteHeight}px` });
        }
        const measured = Math.max(this._noteEl.scrollHeight, this._noteEl.offsetHeight);
        if (measured <= 0) return;
        if (measured > this._maxNoteHeight) {
            this._maxNoteHeight = measured;
            this._noteEl.setCssStyles({ minHeight: `${this._maxNoteHeight}px` });
        }
    }

    /**
     * Constructs a new ProgressFragment.
     * @param options - Initialisation options for value, total, title, and callbacks.
     */
    constructor({ value = 0, total = 0, title = "", onComplete, onCancel, onReady, onProgress, formatNumeric }: {
        value?: number; total?: number; title?: string;
        onComplete?: () => void; onCancel?: () => void;
        onReady?: (fragment: DocumentFragment) => void;
        onProgress?: () => void;
        formatNumeric?: (value: number, total: number, isCancelled: boolean) => string;

    }) {
        this._value = value ?? 0;
        this._total = total ?? 0;
        this._titleText = title ?? "";
        this._onComplete = onComplete;
        this._onCancel = onCancel;
        this._onReady = onReady;
        this._onProgress = onProgress;
        this._formatNumeric = formatNumeric;
        this._fragment = this.constructFragment();
        this.__isApplying = true;
        this.applyProperties();
        this.__isApplying = false;
    }
    /**
     * Constructs the DocumentFragment containing the progress UI.
     * @returns The constructed DocumentFragment.
     */
    constructFragment() {
        const f = activeDocument.createDocumentFragment();
        const d = activeDocument.createElement("div");
        d.classList.add("diffzip-progress-wrap");
        const titleLine = activeDocument.createElement("div");
        titleLine.classList.add("diffzip-progress-title-line");
        const lbl = activeDocument.createElement("label");
        lbl.classList.add("diffzip-progress-title");
        this._titleEl = lbl;
        const numeric = activeDocument.createElement("span");
        numeric.classList.add("diffzip-progress-numeric");
        this._numericStatusEl = numeric;
        titleLine.appendChild(lbl);
        titleLine.appendChild(numeric);
        d.appendChild(titleLine);
        const p = activeDocument.createElement("progress");
        p.classList.add("diffzip-progress-bar");
        this._progressEl = p;
        this._noteEl = activeDocument.createElement("span");
        this._noteEl.classList.add("diffzip-progress-note");
        d.appendChild(p);
        d.appendChild(this._noteEl);
        f.appendChild(d);
        this._wrapperEl = d;
        return f;
    }
    /**
     * Applies the current property values to the UI elements.
     */
    applyProperties() {
        this.title = this._titleText;
        this.total = this._total;
        this.value = this._value;
        this.note = this._noteText;

    }
    /**
     * Reconstructs the DocumentFragment and reapplies properties.
     * @returns The reconstructed DocumentFragment.
     */
    reconstructFragment() {
        this.__isApplying = true;
        this._fragment = this.constructFragment();
        this.applyProperties();
        this.__isApplying = false;
        return this._fragment;
    }
}
