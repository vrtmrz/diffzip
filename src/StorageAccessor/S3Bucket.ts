import { S3 } from "@aws-sdk/client-s3";
import { normalizePath, type Stat } from "obsidian";
import { ObsHttpHandler } from "../ObsHttpHandler.ts";
import { StorageAccessor } from "./StorageAccessor.ts";
import { FileType, StorageAccessorTypes } from "./storage-contracts.ts";
import { toArrayBuffer } from "../util.ts";


export class S3Bucket extends StorageAccessor {
    type = StorageAccessorTypes.S3;
    sep = "/";

    normalizePath(path: string): string {
        return normalizePath(path);
    }

    createFolder(absolutePath: string): Promise<void> {
        // S3 does not have folder concept. So, we don't need to create folder.
        return Promise.resolve();
    }
    override ensureDirectory(fullPath: string): Promise<void> {
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
        await Promise.resolve();
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
            ResponseCacheControl: preventCache ? "no-cache" : undefined
        });
        if (!result.Body) return false;
        const resultByteArray = await result.Body.transformToByteArray() as Uint8Array<ArrayBuffer>;
        return toArrayBuffer(resultByteArray);
    }

    async deleteBinary(path: string): Promise<boolean> {
        const client = await this.getClient();
        try {
            await client.deleteObject({
                Bucket: this.settings.bucket,
                Key: path,
            });
            return true;
        } catch (e) {
            console.error(e);
            return false;
        }
    }

    stat(path: string): Promise<false | Stat> {
        throw new Error("Unsupported operation.");
    }
}
