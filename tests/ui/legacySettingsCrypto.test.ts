import { describe, expect, it } from "vitest";
import { decryptSettingsFromUri, encryptSettingsForUri } from "../../src/legacySettingsCrypto.ts";

const LEGACY_SETTINGS_FIXTURE =
    "%7193d00f753372827c6e9fed01000000e006fa31ccd6923b7a5ef4e9fd692254tKGMX2fYsXsvRD+EVOwk2nLov2XOKkubI5C6tLIWmMpBTcJiuwudviTehFs=";

describe("legacy settings URI encryption", () => {
    it("decrypts settings produced by an earlier DiffZip release", async () => {
        await expect(decryptSettingsFromUri(LEGACY_SETTINGS_FIXTURE, "compat-passphrase")).resolves.toBe(
            '{"startBackupAtLaunch":true}'
        );
    });

    it("keeps newly copied settings compatible with the legacy URI format", async () => {
        const settings = '{"backupFolderMobile":"backup"}';

        const encrypted = await encryptSettingsForUri(settings, "roundtrip-passphrase");

        expect(encrypted.startsWith("%") || encrypted.startsWith("[")).toBe(true);
        await expect(decryptSettingsFromUri(encrypted, "roundtrip-passphrase")).resolves.toBe(settings);
    });
});
