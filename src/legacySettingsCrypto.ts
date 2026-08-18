import * as legacyEncryptionModule from "octagonal-wheels/encryption.js";

type LegacySettingsCrypto = {
    encrypt: (input: string, passphrase: string, autoCalculateIterations: boolean) => Promise<string>;
    decrypt: (encryptedResult: string, passphrase: string, autoCalculateIterations: boolean) => Promise<string>;
};

// Settings URIs predate octagonal-wheels' HKDF format. Keep their wire format
// behind one typed compatibility boundary so existing URIs and older devices
// continue to interoperate without spreading deprecated API use through the UI.
const legacySettingsCrypto = legacyEncryptionModule as unknown as LegacySettingsCrypto;

export function encryptSettingsForUri(settings: string, passphrase: string): Promise<string> {
    return legacySettingsCrypto.encrypt(settings, passphrase, false);
}

export function decryptSettingsFromUri(encryptedSettings: string, passphrase: string): Promise<string> {
    return legacySettingsCrypto.decrypt(encryptedSettings, passphrase, false);
}
