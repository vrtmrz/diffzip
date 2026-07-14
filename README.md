# Differential ZIP Backup

![screenshot](https://github.com/vrtmrz/diffzip/assets/45774780/19ac3972-70e1-462b-b26f-28e7c0f69655)

This is a vault backup plugin for [Obsidian](https://obsidian.md).

We can store all the files which have been modified, into a ZIP file.

## Installation

1. Install this plug-in from [Community Plugins](https://obsidian.md/plugins).

## Development

Contributor setup, tests, architecture notes, and local real-Obsidian workflows are documented in [the developer guide](docs/devs.md).

## How to use

### Making backup
1. Perform `Create Differential Backup` from the command palette.
2. If anything changed, we will get `backupinfo.md` and a zip file `YYYY-M-D-SECONDS.zip` in the `backup` folder
   - `backup` folder can be configured in the settings dialogue.

`Create Differential Backup` compares the current vault with `backupinfo.md` and writes a new ZIP only for changes.
Files under the configured backup folder and restore folder are skipped.
While a backup, restore, or selective-sync Fetch or Send operation is running, DiffZip requests a screen wake lock on supported devices. The request is best effort: the browser or operating system can deny or release it, and it does not keep DiffZip running in the background. DiffZip releases its request when the operation completes, is cancelled, or fails.
It records:

- new files
- files whose content digest changed
- files that existed in the backup history but are now missing locally

The ZIP also contains a copy of the updated `backupinfo.md`, so each backup can describe the state after that backup was created.
If no files changed and no deletion records are needed, ZIP generation is skipped.
If a backup is split into multiple file-count or source-size batches, later batch ZIPs are named like `YYYY-M-D-SECONDS-2.zip`.
If `Max size of each output ZIP file` is configured, a large backup ZIP is split into numbered pieces.
If ZIP encryption is configured, each written backup file is encrypted and must be decrypted with OpenSSL before using ordinary ZIP tools.

Older direct backup variants, such as only-new and non-destructive backup, are available as legacy commands when `Show legacy commands` is enabled.

`Auto backup style` applies only to backups started automatically by `Start backup at launch`.
The command palette item `Create Differential Backup` always uses the standard differential behaviour described above.
If you enable legacy commands, the legacy backup commands explicitly choose their own behaviour and do not inherit `Auto backup style`.

Backup behaviour summary:

| Behaviour | Includes changed files | Skips files whose modified time did not advance | Records locally deleted files as deletion entries |
| --------- | ---------------------- | ----------------------------------------------- | ------------------------------------------------- |
| Standard differential | Yes | No | Yes |
| Only new | Yes | Yes | Yes |
| Non-destructive | Yes | No | No |
| Non-destructive only newer files | Yes | Yes | No |

`Auto backup style` maps to these behaviours when `Start backup at launch` is enabled:

| Auto backup style | Behaviour |
| ----------------- | --------- |
| `Full` | Standard differential |
| `Only New` | Only new |
| `Non-destructive` | Non-destructive only newer files |

### Restore files
1. Perform `Restore from Backup` from the command palette.
2. Check the files or folders you want to restore.
3. Choose the revision to restore when you need a specific backup version.
4. Choose the restore mode and optional prefix.
5. Perform `Restore`.

The restore dialog shows backup history as a searchable file tree.

- Check a file to restore its latest revision, or choose a specific revision from the row dropdown.
- Check a folder row to select or clear all files under that folder.
- Use `Search` with `Select Filtered Latest` to select only matching files.
- Use `Restore point` with `Select Filtered at Point` or `Select All at Point` to select the latest revision at or before a specific time.
- Disable `Show unselected` to focus the list and filtered bulk actions on files that are already selected.
- `Restore Mode` controls how existing local files are handled:
  - `Only new`: restore only files that do not exist locally, or files whose backup revision is newer than the local file.
  - `All`: restore selected files even when local files already exist.
  - `All and delete extra`: restore selected files and include deletion records in the confirmation. Deleting local files from those records is not implemented yet.
- `Additional prefix` restores files under an extra path prefix, such as `restored/`.
  The `Restore folder` setting is used by the legacy restore commands; the current revision selector uses this prefix field instead.

### Selective Sync (Lightweight Synchronisation)
This is now a practical sync workflow, not only a one-way mirror.
We can decide action per file as `None`, `Fetch` (take remote to local), or `Send` (treat current local as source and create new backup entries).
`Fetch` is executed first, then `Send` is executed. If any fetch operation fails, send phase is stopped to keep consistency.

When send is selected, files are grouped into multiple ZIPs while respecting both limits (`Max files in a single ZIP` and `Max total source size in a single ZIP in MB`).
The TOC is updated sequentially per committed ZIP. If TOC update fails, just-created ZIP files are rolled back as much as possible.

1. Perform `Sync Remote Backup` from the command palette.
2. Select each file action (`None`, `Fetch`, or `Send`).
3. Perform `Apply` to run the selected sync operations.

`Sync Remote Backup` requires a remote-style backup destination: S3 compatible bucket or `Anywhere (Desktop only)`.
For regular inside-vault backups, use `Create Differential Backup` and `Restore from Backup`.

### Legacy commands
By default, the command palette shows the simplified commands: `Create Differential Backup`, `Restore from Backup`, and `Sync Remote Backup`.
Older direct commands, such as only-new backup, non-destructive backup, previous restore behaviour, and vault-wide restore commands, are hidden by default.
Enable `Show legacy commands` in the settings and reload the plugin to show them again.

Legacy command meanings:

| Command | Meaning |
| ------- | ------- |
| `Legacy: Create Differential Backup Only Newer Files` | Back up files whose modified time is newer than the current backup TOC entry. Files with unchanged or older modified time are skipped before digest comparison. |
| `Legacy: Create Non-Destructive Differential Backup` | Back up new and changed files, but do not record missing local files as deleted in `backupinfo.md`. |
| `Legacy: Create Non-Destructive Differential Backup Only Newer Files` | Combine the two behaviours above: only newer files are backed up, and missing local files are not recorded as deleted. |
| `Legacy: Restore from backups (previous behaviour)` | Use the older prompt-based restore flow instead of the current revision selector. |
| `Legacy: Restore from backups per folder` | Use the older folder-oriented restore flow. |
| `Legacy: Fetch all new files from the backups` | Restore files from backup history when the local file is missing or older than the backup revision. Existing local files that are newer or identical are left alone. |
| `Legacy: ⚠ Restore Vault from backups and delete with deletion` | Restore the vault from backup history and include deletion records in the confirmation. Deleting local files from those records is not implemented yet. |
| `Legacy: Selective Sync Remote Backup` | Open the older command entry for the current `Sync Remote Backup` workflow. |

## Settings


### General

| Key                                  | Description                                                                                                                                                                             |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start backup at launch               | When the plug-in has been loaded, Differential backup will be created automatically.                                                                                                    |
| Auto backup style | Chooses the behaviour used only by `Start backup at launch`. It does not change the command palette item `Create Differential Backup`. |
| Include hidden folders               | Backup hidden files and folders too. `node_modules`, `.git`, Obsidian trash, and workspace files are still ignored.                                                                     |
| Default destructive sync actions     | On selective sync screen, when enabled, `Delete` defaults to `Fetch` and `Extra (Delete)` defaults to `Send`.                                                                         |
| Show legacy commands                 | Show older command palette entries for direct backup and restore workflows. Reload the plugin after changing this option.                                                              |
| Backup Destination                   | Where to save the backup `Inside the vault`, `Anywhere (Desktop only)`, and `S3 bucket` are available. `Anywhere` is on the bleeding edge. Not safe. Only available on desktop devices. |
| Restore folder                       | The folder used by the legacy restore commands when restoring under the restore folder.                                                                                                  |
| Max files in a single ZIP            | How many source files are stored in a single ZIP file. `0` disables this limit.                                                                                                         |
| Max total source size in a single ZIP in MB | Maximum total source file size grouped into a single ZIP file. `0` disables this limit.                                                                                         |
| Perform all files over the max files | Legacy setting retained for compatibility. Current backups continue by creating additional ZIP batches as needed.                                                                       |
| Max size of each output ZIP file     | Size used to split each output ZIP file. Split ZIP pieces can be handled by 7Z or a compatible archiver.                                                                               |


### On `Inside the vault`

| Key           | Description                                                                          |
| ------------- | ------------------------------------------------------------------------------------ |
| Backup folder | The folder which backups are stored. We can choose only the folder inside the vault. |

### On `Anywhere (Desktop only)`

| Key                     | Description                                                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Backup folder (desktop) | The folder which backups are stored when `Anywhere (Desktop only)` is selected. We can choose any folder (Absolute path recommended). |


### On `S3 Compatible bucket`
| Key                     | Description                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------- |
| Endpoint                | The endpoint of the S3 bucket.                                                        |
| AccessKey               | The access key ID of the S3 bucket.                                                   |
| SecretKey               | The secret access key of the S3 bucket.                                               |
| Region                  | The region of the S3 bucket.                                                          |
| Bucket                  | The name of the S3 bucket.                                                            |
| Use Custom HTTP Handler | Use a custom HTTP handler for S3. This is useful for mobile devices services.         |
| Backup folder           | The folder which backups are stored. We can choose only the folder inside the bucket. |

#### Test and Initialise
- `Test`: Test the connection to the S3 bucket.
- `Create Bucket`: Create a bucket in the S3 bucket.

## Misc

### Reset Backup Information
If you want to make a full backup, you can reset the backup information. This will make all files to be backed up.

### Tools
Here are some tools to manage settings among your devices.

| Key                     | Description                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------- |
| Passphrase                | Passphrase for encrypting/decrypting the configuration. Please write this down as it will not be saved.  |
| Copy setting to another device via URI               | When the button is clicked, the URI will be copied to the clipboard. Paste it to another device to copy the settings. |
| Paste setting from another device                | Paste the URI from another device to copy the settings, and click `Apply` button. |

### Encryption
If you configure the passphrase, the ZIP file will be encrypted by AES-256-CBC with the passphrase.

>[!IMPORTANT]
> Not compatible with the encrypted zip file. We have to decrypt the file by OpenSSL, without this plug-in.
> Decryption command is `openssl enc -d -aes-256-cbc -in <encrypted file> -out <decrypted file> -k <passphrase> -pbkdf2 -md sha256`.




## What is `backupinfo.md`?

This markdown file contains a list of file information. The list is stored as YAML. `backupinfo.md` is also stored in each Zip file.
For the sake of simplicity, suppose we have three files, make a backup, change one of the files and make another backup.

Then we get the following.

```yaml
Untitled.md:
  digest: 452438bd53ea864cdf60269823ea8222366646c14f0f1cd450b5df4a74a7b19b
  filename: Untitled.md
  mtime: 1703656274225
  processed: 1703656274225
  missing: false
  history:
    - zipName: 2023-12-28-41265.zip
      modified: 2023-12-27T05:51:14.225Z
      processed: 1703656274225
      digest: 452438bd53ea864cdf60269823ea8222366646c14f0f1cd450b5df4a74a7b19b
Untitled 2.md:
  digest: 7241f90bf62d00fde6e0cf2ada1beb18776553ded5233f97f0be3f7066c83530
  filename: Untitled 2.md
  mtime: 1703656274225
  processed: 1703656274225
  missing: false
  history:
    - zipName: 2023-12-28-41265.zip
      modified: 2023-12-27T05:51:14.225Z
      processed: 1703656274225
      digest: 7241f90bf62d00fde6e0cf2ada1beb18776553ded5233f97f0be3f7066c83530
Untitled 1.md:
  digest: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
  filename: Untitled 1.md
  mtime: 1708498190402
  processed: 1708498190402
  missing: false
  history:
    - zipName: 2023-12-28-41265.zip
      modified: 2023-12-27T05:51:14.225Z
      processed: 1703656274225
      digest: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    - zipName: 2024-2-21-56995.zip
      modified: 2024-02-21T06:49:50.402Z
      processed: 1708498190402
      digest: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```

The following entries are important.

| key       | value                                                                    |
| --------- | ------------------------------------------------------------------------ |
| digest    | SHA-256 of the file. DZB detects all changes by this hash.               |
| processed | Timestamp at which this TOC entry or history entry was processed.        |
| missing   | Whether the file was recorded as missing locally at the time of backup.  |
| history   | Archived ZIP file name, file modified time, processed time, and digest.  |

Note: Modified time has been stored due to the lack of resolution of the ZIP file, but this is information for us.

### ZIP files
We will get the following zip files.

| 2023-12-28-41265.zip | 2024-2-21-56995.zip |
| -------------------- | ------------------- |
| Untitled.md          |                     |
| Untitled 1.md        |                     |
| Untitled 2.md        | Untitled 1.md       |
| backupinfo.md        | backupinfo.md       |

As the astute will have noticed, we can pick the ZIP that contains the file we want from only the latest one without any special tool!

---
License: MIT
