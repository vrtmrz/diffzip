import type { XByteArray } from "./types.ts";
export { toArrayBuffer } from "octagonal-wheels/binary";

export function* pieces(source: XByteArray, chunkSize: number): Generator<Uint8Array<ArrayBuffer>, void, void> {
    let offset = 0;
    while (offset < source.length) {
        yield source.slice(offset, offset + chunkSize);
        offset += chunkSize;
    }
}
export async function computeDigest(data: XByteArray) {
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
    return hashHex;
}

export function humanReadableSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
    if (bytes < 1024) return `${bytes} B`;

    const units = ["KB", "MB", "GB", "TB", "PB"];
    let value = bytes / 1024;
    let unitIndex = 0;

    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex++;
    }

    const rounded = value >= 10 ? value.toFixed(1) : value.toFixed(2);
    return `${rounded.replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1")} ${units[unitIndex]}`;
}

export function ellipsisMiddle(text: string, maxLength: number = 60) {
    if (text.length <= maxLength) {
        return text;
    }
    const ellipsis = "...";
    const charsToShow = maxLength - ellipsis.length;
    const start = Math.ceil(charsToShow / 2);
    const end = text.length - Math.floor(charsToShow / 2);
    return text.slice(0, start) + ellipsis + text.slice(end);
}
