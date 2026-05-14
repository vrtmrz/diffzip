/**
 * Represents a combination of multiple DocumentFragments.
 * Allows dynamic rebuilding and visibility checking of the combined fragment.
 */
export class CombinedFragment {
    /**
     * The combined DocumentFragment instance.
     */
    _fragment: DocumentFragment;

    /**
     * Array of factory functions that generate DocumentFragments.
     */
    _fragmentFactories: (() => DocumentFragment)[];

    /**
     * Creates a new CombinedFragment from an array of fragment factory functions.
     * @param fragments - Array of functions returning DocumentFragment instances.
     */
    constructor(fragments: (() => DocumentFragment)[]) {
        this._fragmentFactories = fragments;
        this._fragment = this.buildFragment(fragments);
    }

    /**
     * Builds a single DocumentFragment by appending the result of each factory function.
     * @param fragments - Array of functions returning DocumentFragment instances.
     * @returns The combined DocumentFragment.
     */
    buildFragment(fragments: (() => DocumentFragment)[]) {
        const f = activeDocument.createDocumentFragment();
        fragments.forEach(fragment => {
            f.appendChild(fragment());
        });
        return f;
    }

    /**
     * Rebuilds the combined DocumentFragment using the provided or existing factories.
     * @param fragments - Optional array of factory functions. Defaults to current factories.
     * @returns The rebuilt DocumentFragment.
     */
    rebuildFragment(fragments: (() => DocumentFragment)[] = this._fragmentFactories) {
        this._fragmentFactories = fragments;
        this._fragment = this.buildFragment(fragments);
        return this._fragment;
    }

    /**
     * Gets the current combined DocumentFragment.
     */
    get fragment() {
        return this._fragment;
    }

    /**
     * Determines if any child HTMLElement of the fragment is visible (isShown).
     */
    get isVisible() {
        return Array.from(this._fragment.childNodes).some(e => {
            return e.instanceOf(HTMLElement) && e.isShown();
        });
    }
}
