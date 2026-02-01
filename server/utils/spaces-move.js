import { CopyObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { logWizMoveByKey } from './spaces-logger.js';

export async function moveObjectWithVerify({
  s3Client,
  bucketName,
  sourceKey,
  destKey,
  verifyRetries = 3,
  verifyDelayMs = 100,
  logMove = true
}) {
  if (!sourceKey || !destKey || sourceKey === destKey) {
    return;
  }

  await s3Client.send(new CopyObjectCommand({
    Bucket: bucketName,
    CopySource: `${bucketName}/${sourceKey}`,
    Key: destKey
  }));

  let verified = false;
  for (let attempt = 0; attempt < verifyRetries; attempt++) {
    try {
      await s3Client.send(new HeadObjectCommand({
        Bucket: bucketName,
        Key: destKey
      }));
      verified = true;
      break;
    } catch (verifyError) {
      if (attempt < verifyRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, verifyDelayMs * Math.pow(2, attempt)));
      }
    }
  }

  if (!verified) {
    throw new Error('File move verification failed: File not found at destination. Source file preserved.');
  }

  await s3Client.send(new DeleteObjectCommand({
    Bucket: bucketName,
    Key: sourceKey
  }));

  if (logMove) {
    logWizMoveByKey(sourceKey, destKey);
  }
}
