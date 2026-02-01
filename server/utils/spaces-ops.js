import { PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getFileNameFromKey, getFolderLabelFromKey, logWizMove } from './spaces-logger.js';

export async function putObjectWithLog({
  s3Client,
  bucketName,
  key,
  body,
  contentType,
  metadata,
  fromLabel = 'local'
}) {
  await s3Client.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: body,
    ContentType: contentType,
    Metadata: metadata
  }));
  logWizMove(getFileNameFromKey(key), fromLabel, getFolderLabelFromKey(key));
}

export async function deleteObjectWithLog({
  s3Client,
  bucketName,
  key,
  fromLabel
}) {
  await s3Client.send(new DeleteObjectCommand({
    Bucket: bucketName,
    Key: key
  }));
  const label = fromLabel || getFolderLabelFromKey(key);
  logWizMove(getFileNameFromKey(key), label, 'deleted');
}
