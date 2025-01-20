export function* pieces(source: Uint8Array, chunkSize: number): Generator<Uint8Array, void, void> {
	let offset = 0;
	while (offset < source.length) {
		yield source.slice(offset, offset + chunkSize);
		offset += chunkSize;
	}
}
