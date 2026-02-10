/**
 * Script to extract DigitalOcean IDs from existing agents/KBs
 * This helps capture DO_PROJECT_ID, DO_EMBEDDING_MODEL_ID, and the database UUID
 * for OPENSEARCH_URL (add to .env).
 */

import { config } from 'dotenv';
import { DigitalOceanClient } from '../lib/do-client/index.js';

config();

async function extractDOIds() {
  try {
    const token = process.env.DIGITALOCEAN_TOKEN;
    if (!token) {
      console.error('❌ DIGITALOCEAN_TOKEN not found in environment variables');
      console.error('   Make sure your .env file has DIGITALOCEAN_TOKEN set');
      process.exit(1);
    }

    const doClient = new DigitalOceanClient(token);

    console.log('🔍 Extracting DigitalOcean IDs from existing resources...\n');

    // Try to get project ID from agents
    console.log('📋 Checking agents for project ID...');
    try {
      const agents = await doClient.agent.list();
      if (agents.length > 0) {
        const firstAgent = await doClient.agent.get(agents[0].uuid);
        if (firstAgent.project_id) {
          console.log(`✅ Found DO_PROJECT_ID: ${firstAgent.project_id}`);
          console.log(`   Add to .env: DO_PROJECT_ID=${firstAgent.project_id}\n`);
        } else {
          console.log('⚠️  Agent found but no project_id field\n');
        }
      } else {
        console.log('⚠️  No agents found\n');
      }
    } catch (error) {
      console.error('❌ Error getting agents:', error.message);
    }

    // Try to get database ID and embedding model ID from KBs
    console.log('📋 Checking knowledge bases for database ID and embedding model ID...');
    try {
      const kbs = await doClient.kb.list();
      if (kbs.length > 0) {
        const firstKB = await doClient.kb.get(kbs[0].uuid);
        
        if (firstKB.database_id) {
          console.log(`✅ Found database UUID: ${firstKB.database_id}`);
          console.log(`   Add to .env: OPENSEARCH_URL=https://cloud.digitalocean.com/databases/${firstKB.database_id} (copy full URL from DO dashboard)\n`);
        } else {
          console.log('⚠️  KB found but no database_id field\n');
        }

        const embeddingModelId = firstKB.embedding_model_uuid || 
                                 firstKB.embedding_model?.uuid;
        if (embeddingModelId) {
          console.log(`✅ Found DO_EMBEDDING_MODEL_ID: ${embeddingModelId}`);
          console.log(`   Add to .env: DO_EMBEDDING_MODEL_ID=${embeddingModelId}\n`);
        } else {
          console.log('⚠️  KB found but no embedding_model_uuid field\n');
        }
      } else {
        console.log('⚠️  No knowledge bases found\n');
      }
    } catch (error) {
      console.error('❌ Error getting knowledge bases:', error.message);
    }

    console.log('\n📝 Summary - Add these to your .env file:');
    console.log('─────────────────────────────────────────────');
    
    // Generate summary
    try {
      const agents = await doClient.agent.list();
      if (agents.length > 0) {
        const firstAgent = await doClient.agent.get(agents[0].uuid);
        if (firstAgent.project_id) {
          console.log(`DO_PROJECT_ID=${firstAgent.project_id}`);
        }
      }
    } catch (error) {
      // Ignore
    }

    try {
      const kbs = await doClient.kb.list();
      if (kbs.length > 0) {
        const firstKB = await doClient.kb.get(kbs[0].uuid);
        if (firstKB.database_id) {
          console.log(`OPENSEARCH_URL=https://cloud.digitalocean.com/databases/${firstKB.database_id}`);
        }
        const embeddingModelId = firstKB.embedding_model_uuid || 
                                 firstKB.embedding_model?.uuid;
        if (embeddingModelId) {
          console.log(`DO_EMBEDDING_MODEL_ID=${embeddingModelId}`);
        }
      }
    } catch (error) {
      // Ignore
    }
    
    console.log('─────────────────────────────────────────────');

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

extractDOIds();

