/**
 * Test DigitalOcean integration
 */

import dotenv from 'dotenv';
import { DigitalOceanClient } from './lib/do-client/index.js';

dotenv.config();

async function testDO() {
  console.log('🧪 Testing DigitalOcean integration...\n');

  const doClient = new DigitalOceanClient(process.env.DIGITALOCEAN_TOKEN, {
    region: process.env.DO_REGION || 'tor1'
  });

  try {
    // Test 1: List agents
    console.log('1. Testing agent list...');
    const agents = await doClient.agent.list();
    console.log(`✅ Found ${agents.length} agents`);
    if (agents.length > 0) {
      console.log(`   First agent: ${agents[0].name || agents[0].uuid}`);
    }
    console.log('');

    // Test 2: List knowledge bases
    console.log('2. Testing KB list...');
    const kbs = await doClient.kb.list();
    console.log(`✅ Found ${kbs.length} knowledge bases`);
    if (kbs.length > 0) {
      console.log(`   First KB: ${kbs[0].name || kbs[0].uuid}`);
    }
    console.log('');

    // Test 3: Get agent details (if agents exist)
    if (agents.length > 0) {
      console.log('3. Testing get agent...');
      const agent = await doClient.agent.get(agents[0].uuid);
      console.log(`✅ Retrieved agent: ${agent.name || agent.uuid}`);
      console.log(`   Model: ${agent.model?.name || agent.model?.uuid || 'N/A'}`);
      console.log('');
    }

    console.log('✅ DigitalOcean integration tests complete!');
  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.stack) {
      console.error(error.stack);
    }
  }
}

testDO();

