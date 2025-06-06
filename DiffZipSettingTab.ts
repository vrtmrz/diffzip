import { PluginSettingTab, type App, Setting, Notice } from "obsidian";
import { encrypt, decrypt } from "octagonal-wheels/encryption.js";
import DiffZipBackupPlugin from "./main";
import { askSelectString } from "dialog";
import { S3Bucket } from "./storage";
import { AutoBackupType } from "./types";

export class DiffZipSettingTab extends PluginSettingTab {
    plugin: DiffZipBackupPlugin;

    constructor(app: App, plugin: DiffZipBackupPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl("h2", { text: "General" });

        new Setting(containerEl).setName("Start backup at launch").addToggle((toggle) =>
            toggle.setValue(this.plugin.settings.startBackupAtLaunch).onChange(async (value) => {
                this.plugin.settings.startBackupAtLaunch = value;
                await this.plugin.saveSettings();
            })
        );

        new Setting(containerEl)
            .setName("Auto backup style")
            .setDesc("If you want to backup automatically, select the type of backup")
            .addDropdown((dropdown) =>
                dropdown
                    .addOption(AutoBackupType.FULL, "Full")
                    .addOption(AutoBackupType.ONLY_NEW, "Only New")
                    .addOption(AutoBackupType.ONLY_NEW_AND_EXISTING, "Non-destructive")
                    .setValue(this.plugin.settings.startBackupAtLaunchType)
                    .onChange(async (value) => {
                        this.plugin.settings.startBackupAtLaunchType = value as AutoBackupType;
                        await this.plugin.saveSettings();
                    })
            );
        new Setting(containerEl)
            .setName("Include hidden folders")
            .setDesc("node_modules, .git, and trash of Obsidian are ignored automatically")
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.includeHiddenFolder).onChange(async (value) => {
                    this.plugin.settings.includeHiddenFolder = value;
                    await this.plugin.saveSettings();
                })
            );

        containerEl.createEl("h2", { text: "Backup Destination" });
        const dropDownRemote: Record<string, string> = {
            "": "Inside the vault",
            desktop: "Anywhere (Desktop only)",
            s3: "S3 Compatible Bucket",
        };
        if (this.plugin.isMobile) delete dropDownRemote.desktop;
        let backupDestination = this.plugin.settings.desktopFolderEnabled
            ? "desktop"
            : this.plugin.settings.bucketEnabled
              ? "s3"
              : "";

        new Setting(containerEl)
            .setName("Backup Destination")
            .setDesc("Select where to save the backup")
            .addDropdown((dropdown) =>
                dropdown
                    .addOptions(dropDownRemote)
                    .setValue(backupDestination)
                    .onChange(async (value) => {
                        backupDestination = value;
                        this.plugin.settings.desktopFolderEnabled = value == "desktop";
                        this.plugin.settings.bucketEnabled = value == "s3";
                        await this.plugin.saveSettings();
                        this.display();
                    })
            );

        if (backupDestination == "desktop") {
            new Setting(containerEl)
                .setName("Backup folder (desktop)")
                .setDesc(
                    "We can use external folder of Obsidian only if on desktop and it is enabled. This feature uses Internal API."
                )
                .addText((text) =>
                    text
                        .setPlaceholder("c:\\temp\\backup")
                        .setValue(this.plugin.settings.BackupFolderDesktop)
                        .setDisabled(!this.plugin.settings.desktopFolderEnabled)
                        .onChange(async (value) => {
                            this.plugin.settings.BackupFolderDesktop = value;
                            await this.plugin.saveSettings();
                        })
                );
        } else if (backupDestination == "s3") {
            new Setting(containerEl)
                .setName("Endpoint")
                .setDesc("endPoint is a host name or an IP address")
                .addText((text) =>
                    text
                        .setPlaceholder("play.min.io")
                        .setValue(this.plugin.settings.endPoint)
                        .onChange(async (value) => {
                            this.plugin.settings.endPoint = value;
                            await this.plugin.saveSettings();
                        })
                );
            new Setting(containerEl).setName("AccessKey").addText((text) =>
                text
                    .setPlaceholder("Q3................2F")
                    .setValue(this.plugin.settings.accessKey)
                    .onChange(async (value) => {
                        this.plugin.settings.accessKey = value;
                        await this.plugin.saveSettings();
                    })
            );
            new Setting(containerEl).setName("SecretKey").addText((text) =>
                text
                    .setPlaceholder("zuf...................................TG")
                    .setValue(this.plugin.settings.secretKey)
                    .onChange(async (value) => {
                        this.plugin.settings.secretKey = value;
                        await this.plugin.saveSettings();
                    })
            );
            new Setting(containerEl).setName("Region").addText((text) =>
                text
                    .setPlaceholder("us-east-1")
                    .setValue(this.plugin.settings.region)
                    .onChange(async (value) => {
                        this.plugin.settings.region = value;
                        await this.plugin.saveSettings();
                    })
            );
            new Setting(containerEl).setName("Bucket").addText((text) =>
                text.setValue(this.plugin.settings.bucket).onChange(async (value) => {
                    this.plugin.settings.bucket = value;
                    await this.plugin.saveSettings();
                })
            );
            new Setting(containerEl)
                .setName("Use Custom HTTP Handler")
                .setDesc("If you are using a custom HTTP handler, enable this option.")
                .addToggle((toggle) =>
                    toggle.setValue(this.plugin.settings.useCustomHttpHandler).onChange(async (value) => {
                        this.plugin.settings.useCustomHttpHandler = value;
                        await this.plugin.saveSettings();
                    })
                );
            new Setting(containerEl)
                .setName("Test and Initialise")
                .addButton((button) =>
                    button.setButtonText("Test").onClick(async () => {
                        const testS3Adapter = new S3Bucket(this.plugin);
                        const client = await testS3Adapter.getClient();
                        try {
                            const buckets = await client.listBuckets();
                            if (buckets.Buckets?.map((e) => e.Name).indexOf(this.plugin.settings.bucket) !== -1) {
                                new Notice("Connection is successful, and bucket is existing");
                            } else {
                                new Notice("Connection is successful, aut bucket is missing");
                            }
                        } catch (ex) {
                            console.dir(ex);
                            new Notice("Connection failed");
                        }
                    })
                )
                .addButton((button) =>
                    button.setButtonText("Create Bucket").onClick(async () => {
                        const testS3Adapter = new S3Bucket(this.plugin);
                        const client = await testS3Adapter.getClient();
                        try {
                            await client.createBucket({
                                Bucket: this.plugin.settings.bucket,
                                CreateBucketConfiguration: {},
                            });
                            new Notice("Bucket has been created");
                        } catch (ex) {
                            new Notice(`Bucket creation failed\n-----\n${ex?.message ?? "Unknown error"}`);
                            console.dir(ex);
                        }
                    })
                );
            new Setting(containerEl)
                .setName("Backup folder")
                .setDesc("Folder to keep each backup ZIPs and information file")
                .addText((text) =>
                    text
                        .setPlaceholder("backup")
                        .setValue(this.plugin.settings.backupFolderBucket)
                        .onChange(async (value) => {
                            this.plugin.settings.backupFolderBucket = value;
                            await this.plugin.saveSettings();
                        })
                );
        } else {
            new Setting(containerEl)
                .setName("Backup folder")
                .setDesc("Folder to keep each backup ZIPs and information file")
                .addText((text) =>
                    text
                        .setPlaceholder("backup")
                        .setValue(this.plugin.settings.backupFolderMobile)
                        .onChange(async (value) => {
                            this.plugin.settings.backupFolderMobile = value;
                            await this.plugin.saveSettings();
                        })
                );
        }

        containerEl.createEl("h2", { text: "Restore" });

        new Setting(containerEl)
            .setName("Restore folder")
            .setDesc("Folder to save the restored file (Not applied on folder restore)")
            .addText((text) =>
                text
                    .setPlaceholder("restored")
                    .setValue(this.plugin.settings.restoreFolder)
                    .onChange(async (value) => {
                        this.plugin.settings.restoreFolder = value;
                        await this.plugin.saveSettings();
                    })
            );

        containerEl.createEl("h2", { text: "Backup ZIP Settings" });
        new Setting(containerEl)
            .setName("Max files in a single ZIP")
            .setDesc("(0 to disabled) Limit the number of files in a single ZIP file to better restore performance")
            .addText((text) =>
                text
                    .setPlaceholder("100")
                    .setValue(this.plugin.settings.maxFilesInZip + "")
                    .onChange(async (value) => {
                        this.plugin.settings.maxFilesInZip = Number.parseInt(value);
                        await this.plugin.saveSettings();
                    })
            );
        new Setting(containerEl)
            .setName("Perform all files over the max files")
            .setDesc(
                "Automatically process the remaining files, even if the number of files to be processed exceeds Max files."
            )
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.performNextBackupOnMaxFiles).onChange(async (value) => {
                    this.plugin.settings.performNextBackupOnMaxFiles = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName("Max size of each output ZIP file")
            .setDesc("(MB) Size to split the backup zip file. Unzipping requires 7z or other compatible tools.")
            .addText((text) =>
                text
                    .setPlaceholder("30")
                    .setValue(this.plugin.settings.maxSize + "")
                    .onChange(async (value) => {
                        this.plugin.settings.maxSize = Number.parseInt(value);
                        await this.plugin.saveSettings();
                    })
            );

        containerEl.createEl("h2", { text: "Misc" });

        new Setting(containerEl)
            .setName("Reset Backup Information")
            .setDesc("After resetting, backup information will be lost.")
            .addButton((button) =>
                button
                    .setWarning()
                    .setButtonText("Reset")
                    .onClick(async () => {
                        this.plugin.resetToC();
                    })
            );
        new Setting(containerEl)
            .setName("Encryption")
            .setDesc(
                "Warning: This is not compatible with the usual ZIP tools. You can decrypt each file using OpenSSL with openssl  openssl enc -aes-256-cbc  -in [file]  -k [passphrase] -pbkdf2 -d -md sha256 > [out]"
            )
            .addText(
                (text) =>
                    (text
                        .setPlaceholder("Passphrase")
                        .setValue(this.plugin.settings.passphraseOfZip)
                        .onChange(async (value) => {
                            this.plugin.settings.passphraseOfZip = value;
                            await this.plugin.saveSettings();
                        }).inputEl.type = "password")
            );

        containerEl.createEl("h2", { text: "Tools" });
        let passphrase = "";
        new Setting(containerEl)
            .setName("Passphrase")
            .setDesc("You can encrypt the settings with a passphrase")
            .addText(
                (text) =>
                    (text
                        .setPlaceholder("Passphrase")
                        .setValue(passphrase)
                        .onChange(async (value) => {
                            passphrase = value;
                            await this.plugin.saveSettings();
                        }).inputEl.type = "password")
            );

        new Setting(containerEl)
            .setName("Copy setting to another device via URI")
            .setDesc("You can copy the settings to another device by URI")
            .addButton((button) => {
                button.setButtonText("Copy to Clipboard").onClick(async () => {
                    const setting = JSON.stringify(this.plugin.settings);
                    const encrypted = await encrypt(setting, passphrase, false);
                    const uri = `obsidian://diffzip/settings?data=${encodeURIComponent(encrypted)}`;
                    await navigator.clipboard.writeText(uri);
                    new Notice("URI has been copied to the clipboard");
                });
            });

        let copiedURI = "";
        new Setting(containerEl)
            .setName("Paste setting from another device")
            .setDesc("You can paste the settings from another device by URI")
            .addText((text) => {
                text.setPlaceholder("obsidian://diffzip/settings?data=....")
                    .setValue(copiedURI)
                    .onChange(async (value) => {
                        copiedURI = value;
                    });
            })
            .addButton((button) => {
                button.setButtonText("Apply");
                button.setWarning();
                button.onClick(async () => {
                    const uri = copiedURI;
                    const data = decodeURIComponent(uri.split("?data=")[1]);
                    try {
                        const decrypted = await decrypt(data, passphrase, false);
                        const settings = JSON.parse(decrypted);
                        if (
                            (await askSelectString(this.app, "Are you sure to overwrite the settings?", [
                                "Yes",
                                "No",
                            ])) == "Yes"
                        ) {
                            Object.assign(this.plugin.settings, settings);
                            await this.plugin.saveSettings();
                            this.display();
                        } else {
                            new Notice("Cancelled");
                        }
                    } catch (e) {
                        new Notice("Failed to decrypt the settings");
                        console.warn(e);
                    }
                });
            });
    }
}
