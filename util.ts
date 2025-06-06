export function* pieces(source: Uint8Array, chunkSize: number): Generator<Uint8Array, void, void> {
    let offset = 0;
    while (offset < source.length) {
        yield source.slice(offset, offset + chunkSize);
        offset += chunkSize;
    }
}
export async function computeDigest(data: Uint8Array) {
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
    return hashHex;
}
