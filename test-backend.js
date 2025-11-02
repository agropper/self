/**
 * Test script for User app backend
 */

import dotenv from 'dotenv';
import { CloudantClient } from './lib/cloudant/index.js';
import { DigitalOceanClient } from './lib/do-client/index.js';
import { PasskeyService } from './lib/passkey/index.js';

dotenv.config();

async function testBackend() {
  console.log('🧪 Testing User app backend...\n');

  // Test 1: Cloudant connection
  console.log('1. Testing Cloudant connection...');
  try {
    const cloudant = new CloudantClient({
      url: process.env.CLOUDANT_URL,
      username: process.env.CLOUDANT_USERNAME,
      password: process.env.CLOUDANT_PASSWORD
    });

    const connected = await cloudant.testConnection();
    if (connected) {
      console.log('✅ Cloudant connection successful\n');
    } else {
      console.log('❌ Cloudant connection failed (testConnection returned false)\n');
      return;
    }
  } catch (error) {
    console.log(`❌ Cloudant error: ${error.message}`);
    console.log(`   Stack: ${error.stack}`);
    console.log('');
    return;
  }

  // Test 2: Passkey service
  console.log('2. Testing Passkey service...');
  try {
    const passkeyService = new PasskeyService({
      rpID: process.env.PASSKEY_RPID || 'user.agropper.xyz',
      origin: process.env.PASSKEY_ORIGIN || 'http://localhost:3001'
    });

    console.log(`✅ Passkey service initialized`);
    console.log(`   rpID: ${passkeyService.rpID}`);
    console.log(`   origin: ${passkeyService.origin}\n`);
  } catch (error) {
    console.log(`❌ Passkey error: ${error.message}\n`);
    return;
  }

  // Test 3: DigitalOcean client (optional, needs token)
  console.log('3. Testing DigitalOcean client...');
  if (process.env.DIGITALOCEAN_TOKEN && process.env.DIGITALOCEAN_TOKEN !== 'your-do-token-here') {
    try {
      const doClient = new DigitalOceanClient(process.env.DIGITALOCEAN_TOKEN, {
        region: process.env.DO_REGION || 'tor1'
      });
      console.log('✅ DigitalOcean client initialized\n');
    } catch (error) {
      console.log(`❌ DigitalOcean error: ${error.message}\n`);
    }
  } else {
    console.log('⚠️  Skipping (no DIGITALOCEAN_TOKEN configured)\n');
  }

  // Test 4: Cloudant database operations
  console.log('4. Testing Cloudant operations...');
  try {
    const cloudant = new CloudantClient({
      url: process.env.CLOUDANT_URL,
      username: process.env.CLOUDANT_USERNAME,
      password: process.env.CLOUDANT_PASSWORD
    });

    // Try to get a non-existent document (should return null)
    const testDoc = await cloudant.getDocument('maia_users', 'test-user-id');
    console.log(`✅ getDocument works: ${testDoc === null ? 'returns null for non-existent doc' : 'got doc'}`);

    // Try to save a test document
    const testUser = {
      _id: `test-${Date.now()}`,
      userId: 'test-user',
      type: 'test',
      createdAt: new Date().toISOString()
    };

    const saved = await cloudant.saveDocument('maia_users', testUser);
    console.log(`✅ saveDocument works: saved with _id=${saved.id}`);

    // Try to get the document back
    const retrieved = await cloudant.getDocument('maia_users', testUser._id);
    console.log(`✅ getDocument after save works: retrieved doc with userId=${retrieved.userId}`);

    // Clean up
    await cloudant.deleteDocument('maia_users', testUser._id);
    console.log(`✅ deleteDocument works: cleaned up test doc\n`);

  } catch (error) {
    console.log(`❌ Cloudant operations error: ${error.message}\n`);
  }

  console.log('✅ Backend tests complete!');
}

testBackend().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});

