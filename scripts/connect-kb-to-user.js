/**
 * Script to connect an existing KB to a user
 * Usage: node scripts/connect-kb-to-user.js <userId> <kbId>
 */

import { config } from 'dotenv';
import { CloudantClient } from '../lib/cloudant/index.js';
import { DigitalOceanClient } from '../lib/do-client/index.js';

config();

async function connectKB() {
  const userId = process.argv[2];
  const kbId = process.argv[3];

  if (!userId || !kbId) {
    console.error('Usage: node scripts/connect-kb-to-user.js <userId> <kbId>');
    console.error('Example: node scripts/connect-kb-to-user.js do3 3acb4ee8-bb5f-11f0-b074-4e013e2ddde4');
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

    console.log(`\n🔗 Connecting KB ${kbId} to user ${userId}...\n`);

    // Step 1: Get user document
    console.log('📋 Fetching user document...');
    const userDoc = await cloudant.getDocument('maia_users', userId);
    
    if (!userDoc) {
      console.error(`❌ User ${userId} not found`);
      process.exit(1);
    }

    console.log(`✅ User found: ${userDoc.displayName || userId}`);
    console.log(`   Agent: ${userDoc.assignedAgentId || 'None'}`);
    console.log(`   Current KB: ${userDoc.kbId || 'None'}\n`);

    // Step 2: Verify KB exists in DigitalOcean
    console.log('📋 Verifying KB exists in DigitalOcean...');
    try {
      const kbDetails = await doClient.kb.get(kbId);
      console.log(`✅ KB found: ${kbDetails.name}`);
      console.log(`   Tokens: ${kbDetails.total_tokens || 'Unknown'}`);
      console.log(`   Database ID: ${kbDetails.database_id}\n`);
    } catch (error) {
      console.error(`❌ KB ${kbId} not found in DigitalOcean`);
      console.error(`   Error: ${error.message}`);
      process.exit(1);
    }

    // Step 3: Update user document with kbId
    console.log('📝 Updating user document...');
    userDoc.kbId = kbId;
    userDoc.updatedAt = new Date().toISOString();
    
    await cloudant.saveDocument('maia_users', userDoc);
    console.log(`✅ User document updated with kbId\n`);

    // Step 4: Attach KB to agent (if agent exists)
    if (userDoc.assignedAgentId) {
      console.log('🔗 Attaching KB to agent...');
      try {
        await doClient.agent.attachKB(userDoc.assignedAgentId, kbId);
        console.log(`✅ KB attached to agent ${userDoc.assignedAgentId}\n`);
      } catch (error) {
        if (error.message && error.message.includes('already')) {
          console.log(`ℹ️  KB already attached to agent\n`);
        } else {
          console.error(`❌ Error attaching KB to agent: ${error.message}`);
          console.error(`   You may need to attach manually via the UI\n`);
        }
      }
    } else {
      console.log('⚠️  No agent assigned to user - KB linked to user but not attached to agent\n');
    }

    console.log('✅ Done! KB connected successfully.');

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

connectKB();

