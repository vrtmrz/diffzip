export async function encryptCompatOpenSSL(plaintext: Uint8Array, password: string) {
	// Generate a random salt
	const salt = crypto.getRandomValues(new Uint8Array(8));

	// Simulate the same key derivation process as OpenSSL
	const keyMaterial = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(password),
		{ name: 'PBKDF2' },
		false,
		['deriveBits']
	);

	const keyIv = await crypto.subtle.deriveBits(
		{
			name: 'PBKDF2',
			salt: salt,
			iterations: 10000,
			hash: 'SHA-256'
		},
		keyMaterial,
		384 // 32 bytes for key + 16 bytes for IV
	);

	const key = await crypto.subtle.importKey(
		'raw',
		keyIv.slice(0, 32),
		{ name: 'AES-CBC' },
		false,
		['encrypt']
	);


	// Make Initialisation Vector

	const iv = keyIv.slice(32);

	// Encrypt
	const encrypted = await crypto.subtle.encrypt(
		{ name: "AES-CBC", iv: iv },
		key,
		plaintext
	);

	const result = new Uint8Array(8 + salt.length + encrypted.byteLength);
	result.set(new TextEncoder().encode('Salted__'), 0);
	result.set(salt, 8);
	result.set(new Uint8Array(encrypted), 16);

	return result;
}
export async function decryptCompatOpenSSL(encryptedData: Uint8Array, password: string): Promise<Uint8Array> {
	// The first 16 bytes are occupied by "Salted__" (8 bytes) + salt (8 bytes)
	// Check if the encrypted data is too short
	if (encryptedData.length < 16) {
		throw new Error("Encrypted data is too short");
	}

	const salt = encryptedData.slice(8, 16);
	const ciphertext = encryptedData.slice(16);

	// Simulate the same key derivation process as OpenSSL
	const keyMaterial = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(password),
		{ name: 'PBKDF2' },
		false,
		['deriveBits']
	);

	const keyIv = await crypto.subtle.deriveBits(
		{
			name: 'PBKDF2',
			salt: salt,
			iterations: 10000,
			hash: 'SHA-256'
		},
		keyMaterial,
		384 // 32 bytes for key + 16 bytes for IV
	);

	const key = await crypto.subtle.importKey(
		'raw',
		keyIv.slice(0, 32),
		{ name: 'AES-CBC' },
		false,
		['decrypt']
	);

	const iv = keyIv.slice(32);

	// And, decrypt!
	const decrypted = await crypto.subtle.decrypt(
		{ name: "AES-CBC", iv: iv },
		key,
		ciphertext
	);

	return new Uint8Array(decrypted);
}
