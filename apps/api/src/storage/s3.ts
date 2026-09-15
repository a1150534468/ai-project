export { loadS3Config, makeS3 } from "./s3-config.js";
export { getObjectToFile, putObjectFile } from "./s3-files.js";
export { deleteObject, deletePrefix, getObject, putObject } from "./s3-objects.js";
export type {
  DownloadedObject,
  GetObjectToFileOptions,
  PutObjectOptions,
  S3,
  S3Config,
} from "./s3-types.js";
