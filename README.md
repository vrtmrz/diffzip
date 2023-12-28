# Differential ZIP Backup

This is a vault backup plugin for [Obsidian](https://obsidian.md).

We can store all the files which have been modified, into a ZIP file.

## How to use
1. Install this plug-in by [Beta Reviewers Auto-update Tester](https://github.com/TfTHacker/obsidian42-brat).
2. Make a `backup` folder on your vault.
  Note: We can change it on the setting dialogue.
3. Perform `Create Differential Backup ZIP` from the command palette.
4. We will get `backupinfo.md` and a zip file `YYYY-MM-DD-SECONDS.zip`

## What is `backupinfo.md`?

This markdown file contains a list of file information. The list is stored as YAML. `backupinfo.md` is also stored in each Zip file.
For the sake of simplicity, suppose we have three files, make a backup, change one of the files and make another backup.

Then we get the following.

```yaml
Untitled.md:
  digest: 452438bd53ea864cdf60269823ea8222366646c14f0f1cd450b5df4a74a7b19b
  filename: Untitled.md
  mtime: 1703656274225
  storedIn: 2023-12-28-41265.zip
Untitled 2.md:
  digest: 7241f90bf62d00fde6e0cf2ada1beb18776553ded5233f97f0be3f7066c83530
  filename: Untitled 2.md
  mtime: 1703730478953
  storedIn: 2023-12-28-41283.zip
Untitled 1.md:
  digest: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
  filename: Untitled 1.md
  mtime: 1703656280045
  storedIn: 2023-12-28-41265.zip
```

The following entries are important.

| key      | value                                                    |
| -------- | -------------------------------------------------------- |
| digest   | SHA-1 of the file. DZB detects all changes by this hash. |
| storedIn | ZIP file name that the file has been stored.             |

Note: Modified time has been stored due to the lack of resolution of the ZIP file, but this is information for us.

### ZIP files
We will get the following zip files.

| 2023-12-28-41265.zip | 2023-12-28-41283.zip |
| -------------------- | -------------------- |
| Untitled.md          |                      |
| Untitled 1.md        |                      |
| Untitled 2.md        | Untitled 2.md        |
| backupinfo.md        | backupinfo.md        |

As the astute will have noticed, we can pick the ZIP which contains the file we want from only the latest one!

---
License: MIT
