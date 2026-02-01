/**
 * Script to sync KB names and move files to match actual KB in DigitalOcean
 * Usage: node scripts/sync-kb-names-and-files.js <userId> <kbId>
 */

import { config } from 'dotenv';
import { CloudantClient } from '../lib/cloudant/index.js';
import { DigitalOceanClient } from '../lib/do-client/index.js';
import { S3Client, CopyObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { normalizeStorageEnv } from '../server/utils/storage-config.js';

config();
normalizeStorageEnv();

async function syncKB() {
  const userId = process.argv[2];
  const kbId = process.argv[3];

  if (!userId || !kbId) {
    console.error('Usage: node scripts/sync-kb-names-and-files.js <userId> <kbId>');
    console.error('Example: node scripts/sync-kb-names-and-files.js do3 3acb4ee8-bb5f-11f0-b074-4e013e2ddde4');
    process.exit(1);
  }

  try {
    // Initialize clients
    const cloudant = new CloudantClient({
      url: process.env.CLOUDANT_URL,
      username: process.env.CLOUDANT_USERNAME,
      password: process.env.CLOUDANT_PASSWORD
    });

    const doClient = new DigitalOceanClient(process.env.DIGITALOCEAN_TOKEN);

    const bucketUrl = process.env.DIGITALOCEAN_BUCKET;
    const bucketName = bucketUrl?.split('//')[1]?.split('.')[0] || 'maia';

    const s3Client = new S3Client({
      endpoint: process.env.DIGITALOCEAN_ENDPOINT_URL || 'https://tor1.digitaloceanspaces.com',
      region: 'us-east-1',
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
      credentials: {
        accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY || ''
      }
    });

    console.log(`\n🔄 Syncing KB names and files for user ${userId}...\n`);

    // Step 1: Get KB details from DigitalOcean
    console.log('📋 Fetching KB details from DigitalOcean...');
    const kb = await doClient.kb.get(kbId);
    const actualKBName = kb.name;
    console.log(`✅ KB Name in DO: ${actualKBName}`);

    // Check datasources
    if (!kb.datasources || kb.datasources.length === 0) {
      console.error('❌ KB has no datasources. Cannot proceed.');
      console.log('   Add a datasource first using: node scripts/add-datasource-to-kb.js');
      process.exit(1);
    }

    const datasource = kb.datasources[0];
    const datasourcePath = datasource.spaces_data_source?.item_path;
    console.log(`   Datasource Path: ${datasourcePath}\n`);

    // Step 2: Get user document
    console.log('📋 Fetching user document...');
    const userDoc = await cloudant.getDocument('maia_users', userId);
    
    if (!userDoc) {
      console.error(`❌ User ${userId} not found`);
      process.exit(1);
    }

    const oldKBName = userDoc.kbName || userDoc.connectedKB;
    console.log(`   Current kbName in doc: ${oldKBName}`);
    console.log(`   Files in doc: ${userDoc.files?.length || 0}\n`);

    // Step 3: Check if files need to be moved
    const oldPath = `${userId}/${oldKBName}/`;
    const newPath = datasourcePath;

    if (oldPath === newPath) {
      console.log('✅ Paths match - no file move needed\n');
    } else {
      console.log(`📦 Files need to be moved:`);
      console.log(`   From: ${oldPath}`);
      console.log(`   To: ${newPath}\n`);

      // List files in old path
      console.log('📋 Checking for files to move...');
      const listCommand = new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: oldPath
      });

      const listResult = await s3Client.send(listCommand);
      const filesToMove = listResult.Contents || [];

      console.log(`   Found ${filesToMove.length} files to move\n`);

      if (filesToMove.length > 0) {
        // Move each file
        for (const file of filesToMove) {
          const oldKey = file.Key;
          const fileName = oldKey.split('/').pop();
          const newKey = `${newPath}${fileName}`;

          console.log(`   Moving: ${oldKey} → ${newKey}`);

          // Copy to new location
          await s3Client.send(new CopyObjectCommand({
            Bucket: bucketName,
            CopySource: `${bucketName}/${oldKey}`,
            Key: newKey
          }));

          // Delete from old location
          await s3Client.send(new DeleteObjectCommand({
            Bucket: bucketName,
            Key: oldKey
          }));

          console.log(`   ✅ Moved`);
        }
        console.log('');
      }
    }

    // Step 4: Update user document
    console.log('📝 Updating user document...');
    userDoc.kbName = actualKBName;
    userDoc.connectedKBs = [actualKBName];
    userDoc.connectedKB = actualKBName;
    userDoc.updatedAt = new Date().toISOString();

    // Update file metadata if files exist
    if (userDoc.files && Array.isArray(userDoc.files)) {
      userDoc.files.forEach(file => {
        if (file.bucketKey && file.bucketKey.includes(oldKBName)) {
          const oldBucketKey = file.bucketKey;
          file.bucketKey = file.bucketKey.replace(oldKBName, actualKBName);
          console.log(`   Updated file bucketKey: ${oldBucketKey} → ${file.bucketKey}`);
        }
      });
    }

    // Update pending files paths
    if (userDoc.kbPendingFiles && Array.isArray(userDoc.kbPendingFiles)) {
      userDoc.kbPendingFiles = userDoc.kbPendingFiles.map(path => 
        path.replace(oldKBName, actualKBName)
      );
    }

    await cloudant.saveDocument('maia_users', userDoc);
    console.log('✅ User document updated\n');

    console.log('✅ Done! KB names and files synced successfully.');
    console.log('\n💡 Next steps:');
    console.log('   1. Reload the app - KB should show as "Connected"');
    console.log('   2. Click "Create or Update and Index" to trigger indexing');

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error);
    process.exit(1);
  }
}

syncKB();

