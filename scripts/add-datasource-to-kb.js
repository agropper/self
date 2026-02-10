/**
 * Script to add a datasource to an existing KB
 * Usage: node scripts/add-datasource-to-kb.js <kbId> <itemPath>
 */

import { config } from 'dotenv';
import { DigitalOceanClient } from '../lib/do-client/index.js';
import { getSpacesBucketName } from '../server/utils/storage-config.js';

config();

async function addDataSource() {
  const kbId = process.argv[2];
  const itemPath = process.argv[3];

  if (!kbId || !itemPath) {
    console.error('Usage: node scripts/add-datasource-to-kb.js <kbId> <itemPath>');
    console.error('Example: node scripts/add-datasource-to-kb.js 3acb4ee8-bb5f-11f0-b074-4e013e2ddde4 do3/do3-kb-20251106341470/');
    process.exit(1);
  }

  try {
    const doClient = new DigitalOceanClient(process.env.DIGITALOCEAN_TOKEN);

    console.log(`\n📦 Adding datasource to KB ${kbId}...\n`);
    console.log(`   Item Path: ${itemPath}`);

    // Get bucket name from env
    const bucketUrl = getSpacesBucketName();
    const bucketName = bucketUrl?.split('//')[1]?.split('.')[0] || 'maia';
    const region = process.env.DO_REGION || 'tor1';

    console.log(`   Bucket: ${bucketName}`);
    console.log(`   Region: ${region}\n`);

    // Add datasource
    console.log('📤 Calling API to add datasource...');
    const result = await doClient.kb.addDataSource(kbId, {
      bucketName,
      itemPath,
      region
    });

    console.log('✅ Datasource API call completed!');
    console.log('   Response:', JSON.stringify(result, null, 2));
    console.log(`   Datasource UUID: ${result.uuid || result.id || result.data_source?.uuid || 'Unknown'}\n`);

    // Get updated KB details
    const kb = await doClient.kb.get(kbId);
    console.log('📊 Updated KB Details:');
    console.log(`   Name: ${kb.name}`);
    console.log(`   Datasources: ${kb.datasources?.length || 0}`);
    if (kb.datasources && kb.datasources.length > 0) {
      kb.datasources.forEach((ds, idx) => {
        console.log(`   ${idx + 1}. ${ds.spaces_data_source?.item_path || 'Unknown path'}`);
      });
    }
    console.log('');

    console.log('💡 Next step: Trigger indexing by clicking "Create or Update and Index" in the UI');
    console.log('   or wait for DigitalOcean to auto-index the datasource.');

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

addDataSource();

