import { S3 } from "@aws-sdk/client-s3";
import type { Stat } from "obsidian";
import { ObsHttpHandler } from "../ObsHttpHandler.ts";
import { FileType, StorageAccessorTypes } from "../storage.ts";
import { StorageAccessor } from "./StorageAccessor.ts";
import { toArrayBuffer } from "../util.ts";


export class S3Bucket extends StorageAccessor {
    type = StorageAccessorTypes.S3;
    sep = "/";

    createFolder(absolutePath: string): Promise<void> {
        // S3 does not have folder concept. So, we don't need to create folder.
        return Promise.resolve();
    }
    ensureDirectory(fullPath: string): Promise<void> {
        return Promise.resolve();
    }

    async checkType(path: string): Promise<FileType> {
        const client = await this.getClient();
        try {
            await client.headObject({
                Bucket: this.settings.bucket,
                Key: path,
            });
            return FileType.File;
        } catch {
            return FileType.Missing;
        }
    }

    async getClient() {
        const client = new S3({
            endpoint: this.settings.endPoint,
            region: this.settings.region,
            forcePathStyle: true,
            credentials: {
                accessKeyId: this.settings.accessKey,
                secretAccessKey: this.settings.secretKey,
            },
            requestHandler: this.settings.useCustomHttpHandler ? new ObsHttpHandler(undefined, undefined) : undefined,
        });
        return client;
    }

    async _writeBinary(fullPath: string, data: ArrayBuffer) {
        const client = await this.getClient();
        try {
            const r = await client.putObject({
                Bucket: this.settings.bucket,
                Key: fullPath,
                Body: new Uint8Array(data),
            });
            if (~~((r.$metadata.httpStatusCode ?? 500) / 100) == 2) {
                return true;
            } else {
                console.error(`Failed to write binary to ${fullPath} (response code:${r.$metadata.httpStatusCode}).`);
            }
            return false;
        } catch (e) {
            console.error(e);
            return false;
        }
    }

    async _readBinary(fullPath: string, preventCache = false) {
        const client = await this.getClient();
        const result = await client.getObject({
            Bucket: this.settings.bucket,
            Key: fullPath,
            IfNoneMatch: preventCache ? "*" : undefined,
        });
        if (!result.Body) return false;
        const resultByteArray = await result.Body.transformToByteArray() as Uint8Array<ArrayBuffer>;
        return toArrayBuffer(resultByteArray);
    }

    stat(path: string): Promise<false | Stat> {
        throw new Error("Unsupported operation.");
    }
}
