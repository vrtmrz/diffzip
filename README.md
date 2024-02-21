# Differential ZIP Backup

This is a vault backup plugin for [Obsidian](https://obsidian.md).

We can store all the files which have been modified, into a ZIP file.

## Installation

1. Install this plug-in from [Beta Reviewers Auto-update Tester](https://github.com/TfTHacker/obsidian42-brat).

## How to use

### Making backup
1. Perform `Create Differential Backup` from the command palette.
2. We will get `backupinfo.md` and a zip file `YYYY-MM-DD-SECONDS.zip` in the `backup` folder
   - `backup` folder can be configured in the settings dialogue.

### Restore a file
1. Perform `Restore from backups` from the command palette.
2. Select the file you want to restore.
3. Select the backup you want to restore.
4. Select the place to save the restored file.
5. We got an old file.

## Settings

| Key                    | Description                                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Start backup at launch | When the plug-in has been loaded, Differential backup will be created automatically.                                                                               |
| Backup folder          | The folder which backups are stored.                                                                                                                               |
| Restore folder         | The folder which restored files will be stored.                                                                                                                    |
| Include hidden folder  | Backup also the configurations, plugins, themes, and, snippets.                                                                                                    |
| ZIP splitting size     | An large file are not good for handling, so this plug-in splits the backup ZIP into this size. This splitted ZIP files can be handled by 7Z or something archiver. |


## What is `backupinfo.md`?

This markdown file contains a list of file information. The list is stored as YAML. `backupinfo.md` is also stored in each Zip file.
For the sake of simplicity, suppose we have three files, make a backup, change one of the files and make another backup.

Then we get the following.

```yaml
Untitled.md:
  digest: 452438bd53ea864cdf60269823ea8222366646c14f0f1cd450b5df4a74a7b19b
  filename: Untitled.md
  mtime: 1703656274225
  history:
    - zipName: 2023-12-28-41265.zip
      modified: 2023-12-27T05:51:14.225Z
  storedIn: 
Untitled 2.md:
  digest: 7241f90bf62d00fde6e0cf2ada1beb18776553ded5233f97f0be3f7066c83530
  filename: Untitled 2.md
  mtime: 1703656274225
  history:
    - zipName: 2023-12-28-41265.zip
      modified: 2023-12-27T05:51:14.225Z
Untitled 1.md:
  digest: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
  filename: Untitled 1.md
  mtime: 1708498190402
  history:
    - zipName: 2023-12-28-41265.zip
      modified: 2023-12-27T05:51:14.225Z
    - zipName: 2024-2-21-56995.zip
      modified: 2024-02-21T06:49:50.402Z
```

The following entries are important.

| key     | value                                                    |
| ------- | -------------------------------------------------------- |
| digest  | SHA-1 of the file. DZB detects all changes by this hash. |
| history | Archived ZIP file name and Timestamp at the time.        |

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
