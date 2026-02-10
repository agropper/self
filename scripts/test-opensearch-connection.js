#!/usr/bin/env node
/**
 * Test OpenSearch connection for Clinical Notes
 * 
 * Usage: node scripts/test-opensearch-connection.js [userId]
 * 
 * This script tests the OpenSearch connection and creates a test index
 * for the specified userId (or 'test-user' if not provided).
 */

import dotenv from 'dotenv';
import { ClinicalNotesClient } from '../lib/opensearch/clinical-notes.js';
import { getOpenSearchConfig } from '../server/utils/opensearch-config.js';

dotenv.config();

async function testConnection() {
  const userId = process.argv[2] || 'test-user';

  console.log('🧪 Testing OpenSearch connection for Clinical Notes...\n');

  const config = getOpenSearchConfig();
  if (!config?.endpoint) {
    console.error('❌ OpenSearch not configured');
    console.error('   Set in NEW-AGENT.txt ## OpenSearch (DO-managed) or env: OPENSEARCH_ENDPOINT, OPENSEARCH_USERNAME, OPENSEARCH_PASSWORD, DO_DATABASE_ID');
    process.exit(1);
  }

  console.log(`📋 Configuration:`);
  console.log(`   Endpoint: ${config.endpoint}`);
  console.log(`   Username: ${config.username || 'not set'}`);
  console.log(`   Password: ${config.password ? '***' : 'not set'}`);
  console.log(`   Test User ID: ${userId}\n`);

  try {
    // Initialize client
    console.log('🔌 Initializing OpenSearch client...');
    const client = new ClinicalNotesClient({
      endpoint: config.endpoint,
      username: config.username,
      password: config.password,
      databaseId: config.databaseId
    });
    console.log('✅ Client initialized\n');

    // Test 1: Ensure index exists
    console.log('📦 Test 1: Creating/verifying index...');
    const indexResult = await client.ensureIndex(userId);
    console.log(`✅ Index: ${indexResult.indexName}`);
    console.log(`   Exists: ${indexResult.exists}`);
    if (indexResult.created) {
      console.log(`   Created: true\n`);
    } else {
      console.log(`   Created: false (already existed)\n`);
    }

    // Test 2: Index a test note
    console.log('📝 Test 2: Indexing test note...');
    const testNote = {
      fileName: 'test-document.pdf',
      page: 1,
      category: 'Test Category',
      content: 'This is a test clinical note for connection testing.',
      markdown: '## Test Note\n\nThis is a test clinical note for connection testing.'
    };

    const indexResult2 = await client.indexNote(userId, testNote);
    console.log(`✅ Note indexed successfully`);
    console.log(`   Document ID: ${indexResult2.id}`);
    console.log(`   Result: ${indexResult2.result}\n`);

    // Test 3: Search for the note
    console.log('🔍 Test 3: Searching for test note...');
    const searchResult = await client.searchNotes(userId, {
      query: 'test clinical note',
      size: 10
    });
    console.log(`✅ Search completed`);
    console.log(`   Total results: ${searchResult.total}`);
    console.log(`   Hits: ${searchResult.hits.length}\n`);

    if (searchResult.hits.length > 0) {
      console.log('📄 Sample result:');
      const hit = searchResult.hits[0];
      console.log(`   ID: ${hit.id}`);
      console.log(`   Score: ${hit.score}`);
      console.log(`   File: ${hit.source.fileName}`);
      console.log(`   Page: ${hit.source.page}`);
      console.log(`   Category: ${hit.source.category}\n`);
    }

    // Test 4: Get categories
    console.log('📊 Test 4: Getting categories...');
    const categories = await client.getCategories(userId);
    console.log(`✅ Categories retrieved: ${categories.length}`);
    if (categories.length > 0) {
      categories.forEach(cat => {
        console.log(`   - ${cat.category}: ${cat.count} entries`);
      });
    }
    console.log('');

    // Test 5: Bulk indexing
    console.log('📚 Test 5: Bulk indexing multiple notes...');
    const bulkNotes = [
      {
        fileName: 'test-document.pdf',
        page: 2,
        category: 'Allergies',
        content: 'Patient has allergies to penicillin.',
        markdown: '### Allergies\n\nPatient has allergies to penicillin.'
      },
      {
        fileName: 'test-document.pdf',
        page: 3,
        category: 'Medications',
        content: 'Patient is taking metformin.',
        markdown: '### Medications\n\nPatient is taking metformin.'
      }
    ];

    const bulkResult = await client.indexNotesBulk(userId, bulkNotes);
    console.log(`✅ Bulk indexing completed`);
    console.log(`   Indexed: ${bulkResult.indexed} notes`);
    if (bulkResult.errors && bulkResult.errors.length > 0) {
      console.log(`   Errors: ${bulkResult.errors.length}`);
      bulkResult.errors.forEach((err, idx) => {
        console.log(`     ${idx + 1}. ${JSON.stringify(err)}`);
      });
    }
    console.log('');

    // Final summary
    console.log('✅ All tests passed!');
    console.log(`\n💡 Your OpenSearch connection is working correctly.`);
    console.log(`   Index name: ${client.getIndexName(userId)}`);
    console.log(`   You can now use the Clinical Notes API endpoints.\n`);

  } catch (error) {
    console.error('\n❌ Test failed:');
    console.error(`   Error: ${error.message}`);
    if (error.stack) {
      console.error(`   Stack: ${error.stack}`);
    }
    process.exit(1);
  }
}

testConnection();

