import type { XByteArray, XDataView } from "./types.ts";

export function* pieces(source: XByteArray, chunkSize: number): Generator<Uint8Array<ArrayBuffer>, void, void> {
    let offset = 0;
    while (offset < source.length) {
        yield source.slice(offset, offset + chunkSize) as Uint8Array<ArrayBuffer>;
        offset += chunkSize;
    }
}
export async function computeDigest(data: XByteArray) {
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
    return hashHex;
}

export function toArrayBuffer(arr: Uint8Array<ArrayBuffer> | ArrayBuffer | DataView<ArrayBuffer>): ArrayBuffer {
    if (arr instanceof Uint8Array) {
        return arr.buffer;
    }
    if (arr instanceof DataView) {
        return arr.buffer;
    }

    return arr;
}