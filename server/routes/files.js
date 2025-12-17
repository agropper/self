/**
 * File upload and management routes
 * Handles PDF parsing, bucket uploads, and file metadata
 */

import multer from 'multer';
import pdf from 'pdf-parse';
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { extractPdfWithPages, extractIndividualClinicalNotes } from '../utils/pdf-parser.js';
import { ClinicalNotesClient } from '../../lib/opensearch/clinical-notes.js';

/**
 * Extract medication records from markdown
 * Follows the same pattern as extractIndividualClinicalNotes
 * Each medication record has: date, medication name, and dose
 * @param {string} fullMarkdown - Full markdown text from PDF
 * @param {Array} pages - Array of page objects with page numbers
 * @param {string} fileName - Source file name
 * @returns {Array} Array of medication objects
 */
function extractMedicationRecords(fullMarkdown, pages, fileName = '') {
  const medications = [];
  
  // Find ALL "Medication" or "Medication Records" sections
  // Look for headings like "### Medication Records", "## Medications", etc.
  const medicationPattern = /(?:^|\n)(?:#{1,3})\s*Medication\s+Records?\s*(?:\n|$)/gi;
  const allMatches = [];
  let match;
  
  // Find all matches
  while ((match = medicationPattern.exec(fullMarkdown)) !== null) {
    allMatches.push({
      index: match.index,
      length: match[0].length,
      start: match.index + match[0].length
    });
  }
  
  // Also try "Medications" (without "Records")
  const medicationsPattern = /(?:^|\n)(?:#{1,3})\s*Medications\s*(?:\n|$)/gi;
  while ((match = medicationsPattern.exec(fullMarkdown)) !== null) {
    // Check if this is already in allMatches
    const alreadyFound = allMatches.some(m => Math.abs(m.index - match.index) < 10);
    if (!alreadyFound) {
      allMatches.push({
        index: match.index,
        length: match[0].length,
        start: match.index + match[0].length
      });
    }
  }
  
  if (allMatches.length === 0) {
    return medications;
  }
  
  // Process each Medication section
  for (let sectionIdx = 0; sectionIdx < allMatches.length; sectionIdx++) {
    const medicationsBeforeThisSection = medications.length;
    const sectionMatch = allMatches[sectionIdx];
    const sectionStart = sectionMatch.start;
    
    // Find the end of this section (next major heading or next Medication section or end of document)
    let sectionEnd = fullMarkdown.length;
    
    // Check if there's a next Medication section
    if (sectionIdx < allMatches.length - 1) {
      sectionEnd = allMatches[sectionIdx + 1].index;
    } else {
      // Last section - find next major heading (## or #) or end of document
      const restOfMarkdown = fullMarkdown.substring(sectionStart);
      const nextMajorSectionMatch = restOfMarkdown.match(/\n(?:##|#)\s+/);
      if (nextMajorSectionMatch) {
        sectionEnd = sectionStart + nextMajorSectionMatch.index;
      }
    }
    
    // Extract this Medications section
    let medicationsSection = fullMarkdown.substring(sectionStart, sectionEnd);
    
    // Filter out common headers and footers (similar to Clinical Notes)
    const headerFooterPatterns = [
      /^Page\s+\d+/i,
      /^\d+\s*$/m,
      /^Apple\s+Health/i,
      /^Adrian\s+Gropper/i,
      /^\d{4}-\d{2}-\d{2}/,
      /^Generated\s+on/i,
      /^Exported\s+on/i,
    ];
    
    const lines = medicationsSection.split('\n');
    const filteredLines = [];
    const lineFrequency = new Map();
    
    // First pass: count line frequencies
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && trimmed.length > 0) {
        const normalized = trimmed.toLowerCase().replace(/\s+/g, ' ');
        lineFrequency.set(normalized, (lineFrequency.get(normalized) || 0) + 1);
      }
    }
    
    // Second pass: filter out headers/footers
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.length === 0) {
        filteredLines.push(line);
        continue;
      }
      
      const isHeaderFooter = headerFooterPatterns.some(pattern => pattern.test(trimmed));
      const normalized = trimmed.toLowerCase().replace(/\s+/g, ' ');
      const frequency = lineFrequency.get(normalized) || 0;
      const isRepeated = frequency > 5;
      
      if (!isHeaderFooter && !isRepeated) {
        filteredLines.push(line);
      }
    }
    
    medicationsSection = filteredLines.join('\n');
    const processedLines = medicationsSection.split('\n');
    
    // Date patterns (same as Clinical Notes)
    const datePatterns = [
      /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}/i,
      /^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/,
      /^\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}/,
    ];
    
    // Pattern to identify medication entries:
    // Each medication record typically starts with a date line
    // Followed by location (which we'll skip)
    // Then medication name and dose on the same or next line
    let medicationIndex = 0;
    let currentDate = '';
    let currentMedication = null;
    let linesSinceDate = 0; // Track how many lines since we found a date
    
    for (let i = 0; i < processedLines.length; i++) {
      const line = processedLines[i].trim();
      if (!line) continue;
      
      // Check if this line is a date (at the start of the line)
      const isDate = datePatterns.some(pattern => pattern.test(line));
      
      if (isDate && line.length < 50) {
        // Found a date - this likely starts a new medication record
        // Save previous medication if exists
        if (currentMedication && currentMedication.name) {
          medications.push(currentMedication);
        }
        
        currentDate = line;
        currentMedication = null; // Reset for new medication
        linesSinceDate = 0; // Reset counter
        continue;
      }
      
      // If we have a date, look for medication name and dose
      if (currentDate) {
        linesSinceDate++;
        
        // If we've gone more than 5 lines without finding a valid medication, reset
        // This prevents us from treating headers/footers as medications
        if (linesSinceDate > 5 && !currentMedication) {
          currentDate = '';
          currentMedication = null;
          linesSinceDate = 0;
          continue;
        }
        // Skip location lines (common location patterns)
        const isLocation = /mass general|brigham|hospital|medical center|clinic|health center/i.test(line);
        if (isLocation) {
          continue;
        }
        
        // Skip page markers and continuation markers
        const isPageMarker = /(?:^|\s)(?:##\s*)?Page\s+\d+|Continued\s+(?:on|from)\s+Page\s+\d+|Page\s+\d+\s+of/i.test(line);
        if (isPageMarker) {
          // Reset current date if we hit a page marker - it's not a medication entry
          currentDate = '';
          currentMedication = null;
          continue;
        }
        
        // Skip header/footer patterns
        const isHeaderFooter = /Health\s+Page|Date\s+of\s+Birth|Patient\s+Name|Medical\s+Record|Chart\s+Number|MRN|Account\s+Number/i.test(line);
        if (isHeaderFooter) {
          // Reset current date if we hit header/footer - it's not a medication entry
          currentDate = '';
          currentMedication = null;
          continue;
        }
        
        // Skip lines that are too short (likely not medications) or too long (likely paragraphs)
        if (line.length < 3 || line.length > 200) {
          continue;
        }
        
        // Skip lines that look like dates only (no medication info)
        const isDateOnly = datePatterns.some(pattern => pattern.test(line) && line.length < 30);
        if (isDateOnly) {
          continue;
        }
        
        // Skip common non-medication patterns
        const nonMedicationPatterns = [
          /^Date\s+of\s+Birth/i,
          /^Patient\s+ID/i,
          /^MRN/i,
          /^Account/i,
          /^Chart/i,
          /^Record\s+Date/i,
          /^Printed/i,
          /^Generated/i,
          /^Confidential/i,
          /^Page\s+\d+/i,
          /^##\s*Page/i,
          /Continued\s+(on|from)/i,
        ];
        const isNonMedication = nonMedicationPatterns.some(pattern => pattern.test(line));
        if (isNonMedication) {
          // Reset current date - this is not a medication entry
          currentDate = '';
          currentMedication = null;
          continue;
        }
        
        // Look for medication name and dose patterns
        // Medication name is typically at the start of the line
        // Dose might be on the same line or next line
        // Pattern: medication name, possibly followed by dose (e.g., "Aspirin 81 mg" or "hydroCHLOROthiazide 12.5 mg")
        // Updated to support decimal doses: \d+\.?\d* matches integers and decimals like 12, 12.5, 0.5
        const medicationWithDoseMatch = line.match(/^(.+?)\s+(\d+\.?\d*(?:\s*mg|\s*mcg|\s*units?|\s*ml|\s*tablets?|\s*IU|\s*MEQ)?(?:\s+[a-z]+)?)/i);
        const medicationNameOnlyMatch = line.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/);
        
        if (medicationWithDoseMatch) {
          // Found medication with dose on same line
          const medName = medicationWithDoseMatch[1].trim();
          const dose = medicationWithDoseMatch[2].trim();
          
          // Validate that this looks like a real medication name
          // Exclude common non-medication patterns
          const invalidMedicationPatterns = [
            /^Page\s+\d+/i,
            /^##\s*Page/i,
            /Continued\s+(on|from)/i,
            /Date\s+of\s+Birth/i,
            /Health\s+Page/i,
            /^[A-Z][a-z]+\s+Page/i, // "Health Page", "Patient Page", etc.
            /^\d+\s*$/i, // Just numbers
            /^[A-Z]{1,3}\s*$/i, // Just initials
          ];
          
          const isInvalid = invalidMedicationPatterns.some(pattern => pattern.test(medName));
          if (isInvalid) {
            continue;
          }
          
          // Medication names should be at least 2 characters and not just numbers
          if (medName.length < 2 || /^\d+$/.test(medName)) {
            continue;
          }
          
          // Save previous medication if exists
          if (currentMedication && currentMedication.name) {
            medications.push(currentMedication);
          }
          
          currentMedication = {
            id: `${fileName}-med-${medicationIndex++}`,
            name: medName,
            dosage: dose,
            date: currentDate,
            fileName: fileName,
            page: 0, // Will be determined later
            category: 'Medications',
            content: line,
            markdown: line
          };
          
          linesSinceDate = 0; // Reset counter since we found a valid medication
        } else if (medicationNameOnlyMatch && !currentMedication) {
          // Found medication name without dose (dose might be on next line)
          const medName = medicationNameOnlyMatch[1].trim();
          
          // Validate medication name
          const invalidMedicationPatterns = [
            /^Page\s+\d+/i,
            /^##\s*Page/i,
            /Continued\s+(on|from)/i,
            /Date\s+of\s+Birth/i,
            /Health\s+Page/i,
            /^[A-Z][a-z]+\s+Page/i,
            /^\d+\s*$/i,
            /^[A-Z]{1,3}\s*$/i,
          ];
          
          const isInvalid = invalidMedicationPatterns.some(pattern => pattern.test(medName));
          if (isInvalid || medName.length < 2 || /^\d+$/.test(medName)) {
            continue;
          }
          
          currentMedication = {
            id: `${fileName}-med-${medicationIndex++}`,
            name: medName,
            dosage: '',
            date: currentDate,
            fileName: fileName,
            page: 0,
            category: 'Medications',
            content: line,
            markdown: line
          };
          
          linesSinceDate = 0; // Reset counter since we found a valid medication
        } else if (currentMedication && !currentMedication.dosage) {
          // We have a medication but no dose yet - check if this line has a dose
          // Updated to support decimal doses: \d+\.?\d* matches integers and decimals like 12, 12.5, 0.5
          const doseMatch = line.match(/(\d+\.?\d*(?:\s*mg|\s*mcg|\s*units?|\s*ml|\s*tablets?|\s*IU|\s*MEQ)?(?:\s+[a-z]+)?)/i);
          if (doseMatch) {
            currentMedication.dosage = doseMatch[1].trim();
            currentMedication.content += '\n' + line;
            currentMedication.markdown += '\n' + line;
          } else {
            // Not a dose line, might be continuation - append to content
            currentMedication.content += '\n' + line;
            currentMedication.markdown += '\n' + line;
          }
        } else if (currentMedication) {
          // Continuation line - append to content
          currentMedication.content += '\n' + line;
          currentMedication.markdown += '\n' + line;
        }
      }
    }
    
    // Add last medication if exists
    if (currentMedication && currentMedication.name) {
      medications.push(currentMedication);
    }
  }
  
  // Determine page numbers for medications (similar to Clinical Notes)
  for (let medIdx = 0; medIdx < medications.length; medIdx++) {
    const med = medications[medIdx];
    
    // Calculate the character position of this medication in the full markdown
    // We need to find which section it came from and its position within that section
    let medPage = 1;
    
    // Find which section this medication came from by checking its content
    for (let sectionIdx = 0; sectionIdx < allMatches.length; sectionIdx++) {
      const sectionStart = allMatches[sectionIdx].start;
      const sectionEnd = sectionIdx < allMatches.length - 1 
        ? allMatches[sectionIdx + 1].index 
        : fullMarkdown.length;
      
      const sectionContent = fullMarkdown.substring(sectionStart, sectionEnd);
      
      // Check if this medication's content appears in this section
      if (sectionContent.includes(med.content.substring(0, 50))) {
        // Find position within section
        const positionInSection = sectionContent.indexOf(med.content.substring(0, 50));
        const absolutePosition = sectionStart + positionInSection;
        
        // Find which page this position corresponds to
        let accumulatedLength = 0;
        for (const page of pages) {
          const pageHeader = `## Page ${page.page}\n\n`;
          const pageSeparator = `\n\n---\n\n`;
          const pageLength = pageHeader.length + page.markdown.length + pageSeparator.length;
          
          if (absolutePosition >= accumulatedLength && absolutePosition < accumulatedLength + pageLength) {
            medPage = page.page;
            break;
          }
          
          accumulatedLength += pageLength;
        }
        break;
      }
    }
    
    med.page = medPage;
  }
  
  return medications;
}

// User storage limit: 1 GB
const USER_STORAGE_LIMIT = 1024 * 1024 * 1024; // 1 GB in bytes

/**
 * Calculate total size of all files in a user's bucket folder
 * @param {S3Client} s3Client - S3 client instance
 * @param {string} bucketName - Bucket name
 * @param {string} userId - User ID
 * @returns {Promise<number>} Total size in bytes
 */
export async function getUserBucketSize(s3Client, bucketName, userId) {
  let totalSize = 0;
  let continuationToken = null;

  do {
    const listCommand = new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: `${userId}/`,
      ContinuationToken: continuationToken || undefined
    });

    const result = await s3Client.send(listCommand);
    
    if (result.Contents) {
      for (const object of result.Contents) {
        // Exclude .keep files from size calculation
        if (object.Key && !object.Key.endsWith('.keep')) {
          totalSize += object.Size || 0;
        }
      }
    }

    continuationToken = result.NextContinuationToken || null;
  } while (continuationToken);

  return totalSize;
}

// Configure multer for file uploads (in memory)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB limit
  }
});

/**
 * Extract markdown categories using Private AI
 * @param {string} markdown - Full markdown content
 * @param {string} userId - User ID
 * @param {object} cloudant - Cloudant client
 * @param {object} doClient - DigitalOcean client
 * @returns {Promise<Array<{category: string, count: number}>>} Array of categories with counts
 */
async function extractMarkdownCategories(markdown, userId, cloudant, doClient) {
  try {
    // Get user document to access agent info
    const userDoc = await cloudant.getDocument('maia_users', userId);
    
    if (!userDoc || !userDoc.assignedAgentId || !userDoc.agentEndpoint || !userDoc.agentApiKey) {
      throw new Error('Private AI agent not configured for user');
    }

    // Import DigitalOcean provider
    const { DigitalOceanProvider } = await import('../../lib/chat-client/providers/digitalocean.js');
    const { getOrCreateAgentApiKey } = await import('../utils/agent-helper.js');
    
    // Get or create API key
    const apiKey = await getOrCreateAgentApiKey(doClient, cloudant, userId, userDoc.assignedAgentId);
    
    // Create provider
    const agentProvider = new DigitalOceanProvider(apiKey, {
      baseURL: userDoc.agentEndpoint
    });

    // Create prompt
    const prompt = `List the top-level (### ....) markdown categories and the number of occurrences of that heading in the file.

Here is the markdown file:

${markdown}

Please provide a list of all top-level markdown categories (### headings) and the count of each one. Format your response as a simple list, one category per line, with the format: "Category Name: count"`;

    console.log(`🤖 [PDF-MD] Calling Private AI to extract markdown categories for user ${userId}`);

    // Call the agent
    const response = await agentProvider.chat(
      [{ role: 'user', content: prompt }],
      { 
        model: userDoc.agentModelName || 'openai-gpt-oss-120b',
        stream: false
      }
    );

    const aiResponse = response.content || response.text || '';
    
    if (!aiResponse || aiResponse.trim().length === 0) {
      throw new Error('Empty response from Private AI');
    }

    // Parse the AI response to extract categories and counts
    const categories = [];
    const lines = aiResponse.split('\n');
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      
      // Look for patterns like "Category Name: count" or "Category Name - count"
      const match = trimmed.match(/^(.+?)[:\-]\s*(\d+)$/);
      if (match) {
        const category = match[1].trim();
        const count = parseInt(match[2], 10);
        if (category && !isNaN(count)) {
          categories.push({ category, count });
        }
      } else {
        // Try to extract just the category name if no count format found
        // Remove markdown formatting if present
        const cleanCategory = trimmed.replace(/^###\s*/, '').replace(/^\*\s*/, '').replace(/^-\s*/, '').trim();
        if (cleanCategory) {
          categories.push({ category: cleanCategory, count: 0 });
        }
      }
    }

    console.log(`✅ [PDF-MD] Extracted ${categories.length} markdown categories`);
    return categories;
  } catch (error) {
    console.error('❌ [PDF-MD] Error extracting markdown categories:', error);
    throw error;
  }
}

// Helper function to get S3 client
function getS3Client() {
  const bucketUrl = process.env.DIGITALOCEAN_BUCKET;
  if (!bucketUrl) {
    throw new Error('DigitalOcean bucket not configured');
  }

  const bucketName = bucketUrl.split('//')[1]?.split('.')[0] || 'maia';

  return {
    client: new S3Client({
      endpoint: process.env.DIGITALOCEAN_ENDPOINT_URL || 'https://tor1.digitaloceanspaces.com',
      region: 'us-east-1',
      forcePathStyle: false,
      credentials: {
        accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY || ''
      }
    }),
    bucketName
  };
}

// Lazy initialization of OpenSearch client for clinical notes
let clinicalNotesClient = null;

function getClinicalNotesClient() {
  if (clinicalNotesClient) {
    return clinicalNotesClient;
  }

  if (!process.env.OPENSEARCH_ENDPOINT) {
    return null;
  }

  try {
    clinicalNotesClient = new ClinicalNotesClient({
      endpoint: process.env.OPENSEARCH_ENDPOINT,
      username: process.env.OPENSEARCH_USERNAME,
      password: process.env.OPENSEARCH_PASSWORD,
      databaseId: process.env.DO_DATABASE_ID
    });
    console.log('✅ Clinical Notes OpenSearch client initialized');
    return clinicalNotesClient;
  } catch (error) {
    console.warn('⚠️  Failed to initialize Clinical Notes client:', error.message);
    return null;
  }
}

// Helper function to parse date strings in various formats
function parseDate(dateStr) {
  if (!dateStr) return null;
  
  // Try common date formats
  // Format: "Oct 27, 2025" or "October 27, 2025"
  const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const monthMatch = dateStr.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2}),?\s+(\d{4})/i);
  if (monthMatch) {
    const month = monthNames.indexOf(monthMatch[1].toLowerCase().substring(0, 3));
    const day = parseInt(monthMatch[2], 10);
    const year = parseInt(monthMatch[3], 10);
    if (month >= 0) {
      return new Date(year, month, day);
    }
  }
  
  // Format: "10/27/2025" or "10-27-2025"
  const numericMatch = dateStr.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (numericMatch) {
    const month = parseInt(numericMatch[1], 10) - 1;
    const day = parseInt(numericMatch[2], 10);
    let year = parseInt(numericMatch[3], 10);
    if (year < 100) year += 2000; // Handle 2-digit years
    return new Date(year, month, day);
  }
  
  // Format: "2025-10-27"
  const isoMatch = dateStr.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (isoMatch) {
    const year = parseInt(isoMatch[1], 10);
    const month = parseInt(isoMatch[2], 10) - 1;
    const day = parseInt(isoMatch[3], 10);
    return new Date(year, month, day);
  }
  
  // Try native Date parsing as fallback
  const parsed = new Date(dateStr);
  if (!isNaN(parsed.getTime())) {
    return parsed;
  }
  
  return null;
}

export default function setupFileRoutes(app, cloudant, doClient) {
  /**
   * PDF parsing endpoint
   * POST /api/files/parse-pdf
   */
  app.post('/api/files/parse-pdf', upload.single('pdfFile'), async (req, res) => {
    try {
      // Require authentication (regular user or deep-link user)
      const userId = req.session?.userId || req.session?.deepLinkUserId;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      if (!req.file) {
        return res.status(400).json({ error: 'No PDF file provided' });
      }

      // Security checks
      if (req.file.size === 0) {
        return res.status(400).json({ error: 'Empty file provided' });
      }
      
      if (req.file.size > 50 * 1024 * 1024) {
        return res.status(400).json({ error: 'File too large (max 50MB)' });
      }

      // Parse PDF from buffer using pdf-parse
      const data = await pdf(req.file.buffer);

      // Validate parsed content
      if (!data.text || data.text.length === 0) {
        return res.status(400).json({ error: 'Could not extract text from PDF' });
      }

      res.json({
        success: true,
        text: data.text,
        pages: data.numpages,
        characters: data.text.length
      });
    } catch (error) {
      console.error('❌ PDF parsing error:', error);
      res.status(500).json({ error: `Failed to parse PDF: ${error.message}` });
    }
  });

  /**
   * Upload file to DigitalOcean Spaces bucket
   * POST /api/files/upload
   */
  app.post('/api/files/upload', upload.single('file'), async (req, res) => {
    try {
      // Require authentication (regular user or deep-link user)
      const userId = req.session?.userId || req.session?.deepLinkUserId;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      if (!req.file) {
        return res.status(400).json({ error: 'No file provided' });
      }

      // Check if this is an initial import during registration (goes to KB subfolder)
      const isInitialImport = req.body.isInitialImport === 'true';
      const subfolder = req.body.subfolder || '';
      
      // For initial import, use KB subfolder. Otherwise use specified subfolder or root
      let userFolder;
      if (isInitialImport && subfolder) {
        // Initial import goes directly to KB subfolder
        userFolder = `${userId}/${subfolder}/`;
        console.log(`[NEW FLOW] Initial import during registration - uploading to KB folder: ${userFolder}`);
      } else if (subfolder) {
        // Regular subfolder (e.g., "References")
        userFolder = `${userId}/${subfolder}/`;
      } else {
        // Root folder
        userFolder = `${userId}/`;
      }
      
      console.log(`[NEW FLOW] File upload - userId: ${userId}, isInitialImport: ${isInitialImport}, userFolder: ${userFolder}`);
      
      const fileName = req.file.originalname;
      
      // Generate a unique key for the file
      const cleanName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
      const bucketKey = `${userFolder}${cleanName}`;

      // Setup S3/Spaces client
      const bucketUrl = process.env.DIGITALOCEAN_BUCKET;
      if (!bucketUrl) {
        return res.status(500).json({
          error: 'DigitalOcean bucket not configured',
          code: 'BUCKET_NOT_CONFIGURED'
        });
      }

      const bucketName = bucketUrl.split('//')[1]?.split('.')[0] || 'maia';

      const s3Client = new S3Client({
        endpoint: process.env.DIGITALOCEAN_ENDPOINT_URL || 'https://tor1.digitaloceanspaces.com',
        region: 'us-east-1',
        forcePathStyle: false,
        credentials: {
          accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID || '',
          secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY || ''
        }
      });

      // Check user's current storage usage before upload
      const currentSize = await getUserBucketSize(s3Client, bucketName, userId);
      const newFileSize = req.file.size;
      const totalSizeAfterUpload = currentSize + newFileSize;

      if (totalSizeAfterUpload > USER_STORAGE_LIMIT) {
        const currentSizeGB = (currentSize / (1024 * 1024 * 1024)).toFixed(2);
        const limitGB = (USER_STORAGE_LIMIT / (1024 * 1024 * 1024)).toFixed(2);
        const newFileSizeMB = (newFileSize / (1024 * 1024)).toFixed(2);
        const availableMB = ((USER_STORAGE_LIMIT - currentSize) / (1024 * 1024)).toFixed(2);
        
        return res.status(413).json({ 
          error: 'Storage limit exceeded',
          message: `Upload would exceed your storage limit of ${limitGB} GB. Current usage: ${currentSizeGB} GB. File size: ${newFileSizeMB} MB. Available space: ${availableMB} MB.`,
          currentSize,
          newFileSize,
          limit: USER_STORAGE_LIMIT,
          available: USER_STORAGE_LIMIT - currentSize
        });
      }

      // Upload file as binary
      const uploadCommand = new PutObjectCommand({
        Bucket: bucketName,
        Key: bucketKey,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
        Metadata: {
          uploadedBy: userId,
          uploadedAt: new Date().toISOString(),
          originalName: fileName
        }
      });

      await s3Client.send(uploadCommand);
      
      if (isInitialImport) {
        console.log(`[NEW FLOW] ✅ Initial import file uploaded successfully: ${fileName} to ${bucketKey}`);
      }

      // Generate signed URL for reading (valid for 7 days)
      const getCommand = new GetObjectCommand({
        Bucket: bucketName,
        Key: bucketKey
      });

      const fileUrl = await getSignedUrl(s3Client, getCommand, { expiresIn: 604800 });

      res.json({
        success: true,
        fileInfo: {
          bucketKey,
          fileName,
          fileUrl,
          size: req.file.size,
          mimeType: req.file.mimetype,
          uploadedAt: new Date().toISOString(),
          userFolder
        }
      });
    } catch (error) {
      console.error('❌ File upload error:', error);
      res.status(500).json({ error: `Failed to upload file: ${error.message}` });
    }
  });

  /**
   * Proxy PDF files from DigitalOcean Spaces to avoid CORS issues
   * GET /api/files/proxy-pdf/:bucketKey(*)
   */
  app.get('/api/files/proxy-pdf/:bucketKey(*)', async (req, res) => {
    try {
      const { bucketKey } = req.params;
      
      const bucketUrl = process.env.DIGITALOCEAN_BUCKET;
      const bucketName = bucketUrl?.split('//')[1]?.split('.')[0] || 'maia';

      const s3Client = new S3Client({
        endpoint: process.env.DIGITALOCEAN_ENDPOINT_URL || 'https://tor1.digitaloceanspaces.com',
        region: 'us-east-1',
        forcePathStyle: false,
        credentials: {
          accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID || '',
          secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY || ''
        }
      });

      const getCommand = new GetObjectCommand({
        Bucket: bucketName,
        Key: bucketKey
      });
      
      const response = await s3Client.send(getCommand);
      
      // Set appropriate headers
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${bucketKey.split('/').pop()}"`);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      
      // Stream the PDF content
      response.Body.pipe(res);
    } catch (error) {
      console.error('❌ Error proxying PDF:', error);
      res.status(500).json({ 
        success: false,
        error: `Failed to proxy PDF: ${error.message}` 
      });
    }
  });

  /**
   * Get text/markdown file content from DigitalOcean Spaces
   * GET /api/files/get-text/:bucketKey(*)
   */
  app.get('/api/files/get-text/:bucketKey(*)', async (req, res) => {
    try {
      // Require authentication (regular user or deep-link user)
      const userId = req.session?.userId || req.session?.deepLinkUserId;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const { bucketKey } = req.params;
      
      const bucketUrl = process.env.DIGITALOCEAN_BUCKET;
      const bucketName = bucketUrl?.split('//')[1]?.split('.')[0] || 'maia';

      const s3Client = new S3Client({
        endpoint: process.env.DIGITALOCEAN_ENDPOINT_URL || 'https://tor1.digitaloceanspaces.com',
        region: 'us-east-1',
        forcePathStyle: false,
        credentials: {
          accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID || '',
          secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY || ''
        }
      });

      const getCommand = new GetObjectCommand({
        Bucket: bucketName,
        Key: bucketKey
      });
      
      const response = await s3Client.send(getCommand);
      
      // Read the file content as text
      const chunks = [];
      for await (const chunk of response.Body) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);
      const content = buffer.toString('utf-8');
      
      res.json({
        success: true,
        content
      });
    } catch (error) {
      console.error('❌ Error fetching text file:', error);
      res.status(500).json({ 
        success: false,
        error: `Failed to fetch text file: ${error.message}` 
      });
    }
  });

  /**
   * Parse PDF from bucket
   * GET /api/files/parse-pdf-from-bucket/:bucketKey(*)
   */
  app.get('/api/files/parse-pdf-from-bucket/:bucketKey(*)', async (req, res) => {
    try {
      // Require authentication (regular user or deep-link user)
      const userId = req.session?.userId || req.session?.deepLinkUserId;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const { bucketKey } = req.params;
      
      const bucketUrl = process.env.DIGITALOCEAN_BUCKET;
      const bucketName = bucketUrl?.split('//')[1]?.split('.')[0] || 'maia';

      const s3Client = new S3Client({
        endpoint: process.env.DIGITALOCEAN_ENDPOINT_URL || 'https://tor1.digitaloceanspaces.com',
        region: 'us-east-1',
        forcePathStyle: false,
        credentials: {
          accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID || '',
          secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY || ''
        }
      });

      const getCommand = new GetObjectCommand({
        Bucket: bucketName,
        Key: bucketKey
      });
      
      const response = await s3Client.send(getCommand);
      
      // Read the file content
      const chunks = [];
      for await (const chunk of response.Body) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);
      
      // Parse PDF
      const pdfData = await pdf(buffer);
      const text = pdfData.text;
      const pages = pdfData.numpages;
      
      res.json({
        success: true,
        text,
        pages
      });
    } catch (error) {
      console.error('❌ Error parsing PDF from bucket:', error);
      res.status(500).json({ 
        success: false,
        error: `Failed to parse PDF: ${error.message}` 
      });
    }
  });

  /**
   * Get user's storage usage
   * GET /api/files/storage-usage?userId=xxx
   */
  app.get('/api/files/storage-usage', async (req, res) => {
    try {
      const { userId } = req.query;
      
      if (!userId) {
        return res.status(400).json({ 
          error: 'MISSING_USER_ID',
          message: 'User ID is required'
        });
      }

      const bucketUrl = process.env.DIGITALOCEAN_BUCKET;
      if (!bucketUrl) {
        return res.status(500).json({
          error: 'DigitalOcean bucket not configured',
          code: 'BUCKET_NOT_CONFIGURED'
        });
      }

      const bucketName = bucketUrl.split('//')[1]?.split('.')[0] || 'maia';

      const s3Client = new S3Client({
        endpoint: process.env.DIGITALOCEAN_ENDPOINT_URL || 'https://tor1.digitaloceanspaces.com',
        region: 'us-east-1',
        forcePathStyle: false,
        credentials: {
          accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID || '',
          secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY || ''
        }
      });

      const currentSize = await getUserBucketSize(s3Client, bucketName, userId);
      const limit = USER_STORAGE_LIMIT;
      const available = Math.max(0, limit - currentSize);
      const usagePercent = limit > 0 ? ((currentSize / limit) * 100).toFixed(1) : 0;

      res.json({
        success: true,
        currentSize,
        limit,
        available,
        usagePercent: parseFloat(usagePercent),
        currentSizeGB: (currentSize / (1024 * 1024 * 1024)).toFixed(2),
        limitGB: (limit / (1024 * 1024 * 1024)).toFixed(2),
        availableGB: (available / (1024 * 1024 * 1024)).toFixed(2)
      });
    } catch (error) {
      console.error('❌ Error getting storage usage:', error);
      res.status(500).json({ 
        error: `Failed to get storage usage: ${error.message}` 
      });
    }
  });

  /**
   * Get signed URL for a file
   * GET /api/files/:bucketKey/url
   */
  app.get('/api/files/:bucketKey/url', async (req, res) => {
    try {
      const { bucketKey } = req.params;

      const bucketUrl = process.env.DIGITALOCEAN_BUCKET;
      const bucketName = bucketUrl?.split('//')[1]?.split('.')[0] || 'maia';

      const s3Client = new S3Client({
        endpoint: process.env.DIGITALOCEAN_ENDPOINT_URL || 'https://tor1.digitaloceanspaces.com',
        region: 'us-east-1',
        forcePathStyle: false,
        credentials: {
          accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID || '',
          secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY || ''
        }
      });

      const getCommand = new GetObjectCommand({
        Bucket: bucketName,
        Key: bucketKey
      });

      const fileUrl = await getSignedUrl(s3Client, getCommand, { expiresIn: 604800 });

      res.json({ fileUrl });
    } catch (error) {
      console.error('❌ Get signed URL error:', error);
      res.status(500).json({ error: `Failed to get file URL: ${error.message}` });
    }
  });

  /**
   * Extract PDF to markdown with page boundaries preserved
   * POST /api/files/pdf-to-markdown
   */
  app.post('/api/files/pdf-to-markdown', upload.single('pdfFile'), async (req, res) => {
    try {
      // Require authentication (regular user or deep-link user)
      const userId = req.session?.userId || req.session?.deepLinkUserId;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      if (!req.file) {
        return res.status(400).json({ error: 'No PDF file provided' });
      }

      // Security checks
      if (req.file.size === 0) {
        return res.status(400).json({ error: 'Empty file provided' });
      }
      
      if (req.file.size > 50 * 1024 * 1024) {
        return res.status(400).json({ error: 'File too large (max 50MB)' });
      }

      console.log(`📄 [PDF-MD] Extracting PDF to markdown with page boundaries for user ${userId}`);

      // Extract PDF with page boundaries
      const result = await extractPdfWithPages(req.file.buffer);
      const fullMarkdown = result.pages.map(p => `## Page ${p.page}\n\n${p.markdown}`).join('\n\n---\n\n');

      // Extract markdown categories using Private AI if requested
      const extractCategoriesParam = req.query.extractCategories === 'true';
      let categories = [];
      let categoryError = null;
      if (extractCategoriesParam && cloudant && doClient) {
        try {
          categories = await extractMarkdownCategories(fullMarkdown, userId, cloudant, doClient);
        } catch (error) {
          console.error('❌ [PDF-MD] Failed to extract categories:', error);
          // Store error message to return to client
          categoryError = error.message || error.toString();
          // Continue without categories rather than failing the whole request
        }
      }

      // Note: Clinical Notes processing is now done on-demand when user clicks the category
      // Clear existing files in Lists folder before saving new ones
      const { client: s3Client, bucketName } = getS3Client();
      const listsFolder = `${userId}/Lists/`;
      try {
        const listCommand = new ListObjectsV2Command({
          Bucket: bucketName,
          Prefix: listsFolder
        });
        const listResult = await s3Client.send(listCommand);
        const existingFiles = (listResult.Contents || [])
          .filter(obj => obj.Key && !obj.Key.endsWith('.keep'));
        
        const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
        for (const file of existingFiles) {
          try {
            await s3Client.send(new DeleteObjectCommand({
              Bucket: bucketName,
              Key: file.Key
            }));
            console.log(`🗑️ [LISTS] Deleted existing file before processing: ${file.Key}`);
          } catch (err) {
            console.warn(`⚠️ [LISTS] Failed to delete existing file ${file.Key}:`, err);
          }
        }
      } catch (clearError) {
        console.warn('⚠️ [LISTS] Failed to clear Lists folder before processing:', clearError);
        // Continue with processing even if clearing fails
      }

      // Save PDF and processing results to Lists folder
      let savedPdfBucketKey = null;
      let savedResultsBucketKey = null;
      try {
        const cleanFileName = req.file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
        
        // Save PDF file to Lists folder
        savedPdfBucketKey = `${listsFolder}${cleanFileName}`;
        await s3Client.send(new PutObjectCommand({
          Bucket: bucketName,
          Key: savedPdfBucketKey,
          Body: req.file.buffer,
          ContentType: 'application/pdf',
          Metadata: {
            originalName: req.file.originalname,
            processedAt: new Date().toISOString(),
            userId: userId
          }
        }));
        console.log(`💾 [LISTS] Saved PDF to ${savedPdfBucketKey}`);

        // Save processing results as JSON
        const resultsFileName = cleanFileName.replace(/\.pdf$/i, '_results.json');
        savedResultsBucketKey = `${listsFolder}${resultsFileName}`;
        const processingResults = {
          fileName: req.file.originalname,
          totalPages: result.totalPages,
          pages: result.pages,
          categories: categories,
          fullMarkdown: fullMarkdown,
          categoryError: categoryError || undefined,
          processedAt: new Date().toISOString(),
          pdfProcessedAt: new Date().toISOString() // Track when PDF was processed
        };
        
        await s3Client.send(new PutObjectCommand({
          Bucket: bucketName,
          Key: savedResultsBucketKey,
          Body: JSON.stringify(processingResults, null, 2),
          ContentType: 'application/json',
          Metadata: {
            originalName: req.file.originalname,
            processedAt: new Date().toISOString(),
            userId: userId
          }
        }));
        console.log(`💾 [LISTS] Saved processing results to ${savedResultsBucketKey}`);
      } catch (saveError) {
        console.error('⚠️ [LISTS] Failed to save PDF/results to Lists folder:', saveError);
        // Don't fail the request if saving fails
      }

      res.json({
        success: true,
        totalPages: result.totalPages,
        pages: result.pages,
        categories: categories,
        fullMarkdown: fullMarkdown,
        categoryError: categoryError || undefined,
        savedPdfBucketKey,
        savedResultsBucketKey
      });
    } catch (error) {
      console.error('❌ PDF to markdown extraction error:', error);
      res.status(500).json({ error: `Failed to extract PDF: ${error.message}` });
    }
  });

  /**
   * Extract PDF to markdown from bucket file
   * POST /api/files/pdf-to-markdown/:bucketKey(*)
   */
  app.post('/api/files/pdf-to-markdown/:bucketKey(*)', async (req, res) => {
    try {
      // Require authentication (regular user or deep-link user)
      const userId = req.session?.userId || req.session?.deepLinkUserId;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const { bucketKey } = req.params;
      
      const { client: s3Client, bucketName } = getS3Client();

      // Clear cached list files when re-processing
      try {
        const listsFolder = `${userId}/Lists/`;
        if (bucketKey.startsWith(listsFolder)) {
          // List all _list.json files and delete them
          const listCommand = new ListObjectsV2Command({
            Bucket: bucketName,
            Prefix: listsFolder
          });
          const listResult = await s3Client.send(listCommand);
          const listFiles = (listResult.Contents || [])
            .filter(obj => obj.Key && obj.Key.endsWith('_list.json'));
          
          const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
          for (const file of listFiles) {
            try {
              await s3Client.send(new DeleteObjectCommand({
                Bucket: bucketName,
                Key: file.Key
              }));
              console.log(`🗑️ [LISTS] Deleted cached list file during re-process: ${file.Key}`);
            } catch (err) {
              console.warn(`⚠️ [LISTS] Failed to delete cached list file ${file.Key}:`, err);
            }
          }
        }
      } catch (cacheError) {
        console.warn('⚠️ [LISTS] Failed to clear cache during re-process:', cacheError);
        // Continue with processing even if cache clearing fails
      }

      const getCommand = new GetObjectCommand({
        Bucket: bucketName,
        Key: bucketKey
      });
      
      let response;
      try {
        response = await s3Client.send(getCommand);
      } catch (s3Error) {
        if (s3Error.name === 'NoSuchKey' || s3Error.$metadata?.httpStatusCode === 404) {
          console.error(`❌ [PDF-MD] File not found: ${bucketKey}`);
          return res.status(404).json({ error: `File not found: ${bucketKey}` });
        }
        throw s3Error;
      }
      
      // Read the PDF file content
      const chunks = [];
      for await (const chunk of response.Body) {
        chunks.push(chunk);
      }
      const pdfBuffer = Buffer.concat(chunks);

      console.log(`📄 [PDF-MD] Extracting PDF to markdown from bucket file ${bucketKey} for user ${userId}`);

      // Extract PDF with page boundaries
      const result = await extractPdfWithPages(pdfBuffer);
      const fullMarkdown = result.pages.map(p => `## Page ${p.page}\n\n${p.markdown}`).join('\n\n---\n\n');
      const fileName = bucketKey.split('/').pop() || 'unknown.pdf';

      // Extract markdown categories using Private AI if requested
      const extractCategoriesParam = req.query.extractCategories === 'true';
      let categories = [];
      let categoryError = null;
      if (extractCategoriesParam && cloudant && doClient) {
        try {
          categories = await extractMarkdownCategories(fullMarkdown, userId, cloudant, doClient);
        } catch (error) {
          console.error('❌ [PDF-MD] Failed to extract categories:', error);
          // Store error message to return to client
          categoryError = error.message || error.toString();
          // Continue without categories rather than failing the whole request
        }
      }

      // Note: Clinical Notes processing is now done on-demand when user clicks the category
      // Clear existing files in Lists folder before saving new ones
      const listsFolder = `${userId}/Lists/`;
      try {
        const listCommand = new ListObjectsV2Command({
          Bucket: bucketName,
          Prefix: listsFolder
        });
        const listResult = await s3Client.send(listCommand);
        const existingFiles = (listResult.Contents || [])
          .filter(obj => obj.Key && !obj.Key.endsWith('.keep'));
        
        const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
        for (const file of existingFiles) {
          try {
            await s3Client.send(new DeleteObjectCommand({
              Bucket: bucketName,
              Key: file.Key
            }));
            console.log(`🗑️ [LISTS] Deleted existing file before processing: ${file.Key}`);
          } catch (err) {
            console.warn(`⚠️ [LISTS] Failed to delete existing file ${file.Key}:`, err);
          }
        }
      } catch (clearError) {
        console.warn('⚠️ [LISTS] Failed to clear Lists folder before processing:', clearError);
        // Continue with processing even if clearing fails
      }

      // Save PDF and processing results to Lists folder
      let savedPdfBucketKey = null;
      let savedResultsBucketKey = null;
      try {
        const cleanFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
        
        // Copy PDF file to Lists folder (if not already there)
        if (!bucketKey.startsWith(listsFolder)) {
          savedPdfBucketKey = `${listsFolder}${cleanFileName}`;
          await s3Client.send(new PutObjectCommand({
            Bucket: bucketName,
            Key: savedPdfBucketKey,
            Body: pdfBuffer,
            ContentType: 'application/pdf',
            Metadata: {
              originalName: fileName,
              processedAt: new Date().toISOString(),
              userId: userId,
              sourceBucketKey: bucketKey
            }
          }));
          console.log(`💾 [LISTS] Saved PDF to ${savedPdfBucketKey}`);
        } else {
          savedPdfBucketKey = bucketKey;
        }

        // Save processing results as JSON
        const resultsFileName = cleanFileName.replace(/\.pdf$/i, '_results.json');
        savedResultsBucketKey = `${listsFolder}${resultsFileName}`;
        const processingResults = {
          fileName: fileName,
          totalPages: result.totalPages,
          pages: result.pages,
          categories: categories,
          fullMarkdown: fullMarkdown,
          categoryError: categoryError || undefined,
          processedAt: new Date().toISOString(),
          pdfProcessedAt: new Date().toISOString() // Track when PDF was processed
        };
        
        await s3Client.send(new PutObjectCommand({
          Bucket: bucketName,
          Key: savedResultsBucketKey,
          Body: JSON.stringify(processingResults, null, 2),
          ContentType: 'application/json',
          Metadata: {
            originalName: fileName,
            processedAt: new Date().toISOString(),
            userId: userId
          }
        }));
        console.log(`💾 [LISTS] Saved processing results to ${savedResultsBucketKey}`);
      } catch (saveError) {
        console.error('⚠️ [LISTS] Failed to save PDF/results to Lists folder:', saveError);
        // Don't fail the request if saving fails
      }

      res.json({
        success: true,
        totalPages: result.totalPages,
        pages: result.pages,
        categories: categories,
        fullMarkdown: fullMarkdown,
        categoryError: categoryError || undefined,
        savedPdfBucketKey,
        savedResultsBucketKey
      });
    } catch (error) {
      console.error('❌ PDF to markdown extraction error:', error);
      res.status(500).json({ error: `Failed to extract PDF: ${error.message}` });
    }
  });

  /**
   * Process Clinical Notes category on demand
   * POST /api/files/lists/process-category
   */
  app.post('/api/files/lists/process-category', async (req, res) => {
    try {
      // Require authentication
      const userId = req.session?.userId || req.session?.deepLinkUserId;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const { categoryName, resultsBucketKey } = req.body;
      
      if (!categoryName || !resultsBucketKey) {
        return res.status(400).json({ error: 'categoryName and resultsBucketKey are required' });
      }

      // Support Clinical Notes and Medication Records for now
      const normalizedCategory = categoryName.toLowerCase();
      const isClinicalNotes = normalizedCategory.includes('clinical notes');
      const isMedicationRecords = normalizedCategory.includes('medication');
      
      if (!isClinicalNotes && !isMedicationRecords) {
        return res.status(400).json({ error: 'Only Clinical Notes and Medication Records categories are supported' });
      }

      const { client: s3Client, bucketName } = getS3Client();

      // Load the saved processing results
      const getResultsCommand = new GetObjectCommand({
        Bucket: bucketName,
        Key: resultsBucketKey
      });

      const resultsResponse = await s3Client.send(getResultsCommand);
      const resultsChunks = [];
      for await (const chunk of resultsResponse.Body) {
        resultsChunks.push(chunk);
      }
      const resultsJson = Buffer.concat(resultsChunks).toString('utf-8');
      const processingResults = JSON.parse(resultsJson);

      // Check if we have a saved list file for this category
      const listsFolder = `${userId}/Lists/`;
      const cleanFileName = processingResults.fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
      const listFileName = `${cleanFileName.replace(/\.pdf$/i, '')}_${categoryName.toLowerCase().replace(/\s+/g, '_')}_list.json`;
      const listBucketKey = `${listsFolder}${listFileName}`;

      // Check if list file exists and if it's still valid (PDF hasn't been reprocessed)
      let existingList = null;
      let listIsStale = false;
      try {
        const getListCommand = new GetObjectCommand({
          Bucket: bucketName,
          Key: listBucketKey
        });
        const listResponse = await s3Client.send(getListCommand);
        const listChunks = [];
        for await (const chunk of listResponse.Body) {
          listChunks.push(chunk);
        }
        const listJson = Buffer.concat(listChunks).toString('utf-8');
        existingList = JSON.parse(listJson);
        
        // Check if PDF was reprocessed after list was created
        const listProcessedAt = new Date(existingList.processedAt || 0);
        const pdfProcessedAt = new Date(processingResults.pdfProcessedAt || 0);
        listIsStale = pdfProcessedAt > listProcessedAt;
      } catch (err) {
        // List file doesn't exist, that's fine
        console.log(`📝 [LISTS] No existing list file found for ${categoryName}`);
      }

      // If list exists and is not stale, return it
      if (existingList && !listIsStale) {
        console.log(`✅ [LISTS] Returning cached list for ${categoryName}`);
        return res.json({
          success: true,
          categoryName,
          list: existingList.list,
          indexed: existingList.indexed,
          processedAt: existingList.processedAt,
          fromCache: true
        });
      }

      // Process the category
      console.log(`📝 [LISTS] Processing ${categoryName} category on demand`);
      
      let individualItems = [];
      let indexedResult = null;
      
      if (isClinicalNotes) {
        // Process Clinical Notes
        const notesClient = getClinicalNotesClient();
        if (!notesClient) {
          return res.status(503).json({ 
            error: 'Clinical Notes indexing not configured',
            message: 'OPENSEARCH_ENDPOINT environment variable is required'
          });
        }
        
        // Delete existing notes for this file before indexing new ones
        const deleteResult = await notesClient.deleteNotesByFileName(userId, processingResults.fileName);
        
        // Extract individual notes
        individualItems = extractIndividualClinicalNotes(
          processingResults.fullMarkdown,
          processingResults.pages,
          processingResults.fileName
        );
        
        if (individualItems.length > 0) {
          const bulkResult = await notesClient.indexNotesBulk(userId, individualItems);
          indexedResult = {
            total: individualItems.length,
            indexed: bulkResult.indexed,
            errors: bulkResult.errors || [],
            deleted: deleteResult.deleted
          };
        } else {
          indexedResult = {
            total: 0,
            indexed: 0,
            errors: ['No individual notes could be extracted from Clinical Notes section'],
            deleted: deleteResult.deleted
          };
        }
      } else if (isMedicationRecords) {
        // Process Medication Records
        individualItems = extractMedicationRecords(
          processingResults.fullMarkdown,
          processingResults.pages,
          processingResults.fileName
        );
        
        indexedResult = {
          total: individualItems.length,
          indexed: individualItems.length, // Medications are just extracted, not indexed to OpenSearch
          errors: [],
          deleted: 0
        };
      }

      // Save the processed list to file
      const listData = {
        categoryName,
        fileName: processingResults.fileName,
        list: individualItems,
        indexed: indexedResult,
        processedAt: new Date().toISOString(),
        pdfProcessedAt: processingResults.pdfProcessedAt
      };

      await s3Client.send(new PutObjectCommand({
        Bucket: bucketName,
        Key: listBucketKey,
        Body: JSON.stringify(listData, null, 2),
        ContentType: 'application/json',
        Metadata: {
          categoryName: categoryName,
          fileName: processingResults.fileName,
          processedAt: new Date().toISOString(),
          userId: userId
        }
      }));
      console.log(`💾 [LISTS] Saved processed list to ${listBucketKey}`);

      res.json({
        success: true,
        categoryName,
        list: individualItems,
        indexed: indexedResult,
        processedAt: listData.processedAt,
        fromCache: false
      });
    } catch (error) {
      console.error('❌ Error processing category:', error);
      res.status(500).json({ error: `Failed to process category: ${error.message}` });
    }
  });

  /**
   * Clear all files in Lists folder when PDF is re-processed
   * POST /api/files/lists/clear-cache
   */
  app.post('/api/files/lists/clear-cache', async (req, res) => {
    try {
      // Require authentication
      const userId = req.session?.userId || req.session?.deepLinkUserId;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const { client: s3Client, bucketName } = getS3Client();
      const listsFolder = `${userId}/Lists/`;

      // List all files in Lists folder
      const listCommand = new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: listsFolder
      });

      const listResult = await s3Client.send(listCommand);
      
      // Delete ALL files in Lists folder (PDF, results, and cached lists)
      const allFiles = (listResult.Contents || [])
        .filter(obj => obj.Key && !obj.Key.endsWith('.keep'));

      const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
      let deletedCount = 0;
      
      for (const file of allFiles) {
        try {
          await s3Client.send(new DeleteObjectCommand({
            Bucket: bucketName,
            Key: file.Key
          }));
          deletedCount++;
          console.log(`🗑️ [LISTS] Deleted file: ${file.Key}`);
        } catch (err) {
          console.error(`❌ [LISTS] Failed to delete file ${file.Key}:`, err);
        }
      }

      res.json({
        success: true,
        deletedCount
      });
    } catch (error) {
      console.error('❌ Error clearing Lists folder:', error);
      res.status(500).json({ error: `Failed to clear Lists folder: ${error.message}` });
    }
  });

  /**
   * Process initial file for Lists extraction
   * POST /api/files/lists/process-initial-file
   * Accepts optional bucketKey and fileName in request body to process a specific file
   */
  app.post('/api/files/lists/process-initial-file', async (req, res) => {
    console.log(`🚀 [LISTS] POST /api/files/lists/process-initial-file called`);
    try {
      // Require authentication
      const userId = req.session?.userId || req.session?.deepLinkUserId;
      if (!userId) {
        console.log(`❌ [LISTS] Authentication failed - no userId in session`);
        return res.status(401).json({ error: 'Authentication required' });
      }
      console.log(`✅ [LISTS] Authenticated user: ${userId}`);

      const { bucketKey: providedBucketKey, fileName: providedFileName } = req.body || {};
      console.log(`📋 [LISTS] Request body:`, JSON.stringify(req.body));
      console.log(`📋 [LISTS] Provided bucketKey:`, providedBucketKey);
      console.log(`📋 [LISTS] Provided fileName:`, providedFileName);
      
      let initialFileBucketKey;
      let initialFileName;

      // If bucketKey is provided in request, use it directly (for file replacement)
      if (providedBucketKey) {
        initialFileBucketKey = providedBucketKey;
        initialFileName = providedFileName || 'Replaced File';
        console.log(`📄 [LISTS] Using provided file: ${initialFileName} (${initialFileBucketKey})`);
      } else {
        console.log(`📄 [LISTS] No bucketKey provided, checking user document...`);
        // Otherwise, get from user document (original flow)
        const userDoc = await cloudant.getDocument('maia_users', userId);
        if (!userDoc) {
          return res.status(404).json({ error: 'User not found' });
        }

        if (!userDoc.initialFile || !userDoc.initialFile.bucketKey) {
          return res.status(400).json({ error: 'No initial file found for this user' });
        }

        initialFileBucketKey = userDoc.initialFile.bucketKey;
        initialFileName = userDoc.initialFile.fileName;
      }

      const { client: s3Client, bucketName } = getS3Client();

      console.log(`📄 [LISTS] Processing initial file for Lists: ${initialFileName} (${initialFileBucketKey})`);
      console.log(`📄 [LISTS] Using bucket: ${bucketName}`);

      // Get PDF from S3
      const { GetObjectCommand } = await import('@aws-sdk/client-s3');
      const getCommand = new GetObjectCommand({
        Bucket: bucketName,
        Key: initialFileBucketKey
      });
      
      let response;
      try {
        response = await s3Client.send(getCommand);
      } catch (err) {
        console.error(`❌ [LISTS] Failed to get initial file from S3: ${err.message}`);
        return res.status(404).json({ error: `Initial file not found: ${err.message}` });
      }

      // Read PDF buffer
      const chunks = [];
      for await (const chunk of response.Body) {
        chunks.push(chunk);
      }
      const pdfBuffer = Buffer.concat(chunks);

      // Extract PDF with page boundaries (Step 3.1)
      const result = await extractPdfWithPages(pdfBuffer);
      let fullMarkdown = result.pages.map(p => `## Page ${p.page}\n\n${p.markdown}`).join('\n\n---\n\n');
      
      // Clean up page footers: Find "Health   Page nn of mm" patterns
      // Remove all lines from footer up to (but not including) next "###" line
      // Also look backward for "Continued on " lines and remove them
      // Replace with "## Page nn" where nn is the NEXT page (footer is at end of previous page)
      const pageFooterPattern = /^.*[Hh]ealth\s+[Pp]age\s+(\d+)\s+of\s+\d+.*$/;
      const continuedOnPattern = /^.*[Cc]ontinued\s+on\s+.*$/;
      
      let pagesCleaned = 0;
      const lines = fullMarkdown.split('\n');
      const cleanedLines = [];
      let i = 0;

      while (i < lines.length) {
        const line = lines[i];
        const trimmedLine = line.trim();
        
        // Check if current line matches "Health   Page nn of mm" pattern
        const footerMatch = trimmedLine.match(pageFooterPattern);
        
        if (footerMatch) {
          // Footer "Health   Page 32 of 133" is at the END of page 32
          // The content that follows is the START of page 33
          // So we need to use pageNum + 1 for the replacement header
          const footerPageNum = parseInt(footerMatch[1], 10);
          const nextPageNum = footerPageNum + 1;
          
          // Look backward a couple of lines for "Continued on " pattern
          let lookBackIndex = cleanedLines.length - 1;
          let foundContinuedOn = false;
          let continuedOnIndex = -1;
          let linesChecked = 0;
          
          while (lookBackIndex >= 0 && linesChecked < 3) {
            const prevTrimmed = cleanedLines[lookBackIndex].trim();
            
            if (prevTrimmed.match(continuedOnPattern)) {
              foundContinuedOn = true;
              continuedOnIndex = lookBackIndex;
              break;
            }
            
            // Skip empty lines when counting
            if (prevTrimmed !== '') {
              linesChecked++;
            }
            
            lookBackIndex--;
          }
          
          // Remove "Continued on " line if found
          if (foundContinuedOn && continuedOnIndex >= 0) {
            cleanedLines.splice(continuedOnIndex, 1);
          }
          
          // Look ahead to find the next line that starts with "###"
          let j = i + 1;
          let foundNextHeader = false;
          let nextHeaderIndex = -1;
          
          while (j < lines.length) {
            const nextTrimmed = lines[j].trim();
            
            // Check if this line starts with "###"
            if (nextTrimmed.startsWith('###')) {
              foundNextHeader = true;
              nextHeaderIndex = j;
              break;
            }
            
            j++;
          }
          
          if (foundNextHeader && nextHeaderIndex > i) {
            // Found footer and next header - remove all lines from footer to (but not including) next header
            // Replace with "## Page nn" where nn is the NEXT page (footer was at end of previous page)
            cleanedLines.push(`## Page ${nextPageNum}`);
            pagesCleaned++;
            // Skip all lines from footer to just before the next header
            i = nextHeaderIndex;
            continue;
          } else {
            // Footer found but no next header - just remove the footer line and replace with page header
            cleanedLines.push(`## Page ${nextPageNum}`);
            pagesCleaned++;
            i++;
            continue;
          }
        }
        
        // Regular line - keep it
        cleanedLines.push(line);
        i++;
      }
      
      fullMarkdown = cleanedLines.join('\n');
      
      if (pagesCleaned > 0) {
        console.log(`🧹 [LISTS] Cleaned ${pagesCleaned} page(s) by removing page footers`);
      }

      // Remove last 4 lines from markdown
      const markdownLines = fullMarkdown.split('\n');
      if (markdownLines.length > 4) {
        markdownLines.splice(-4);
        fullMarkdown = markdownLines.join('\n');
        console.log(`✂️ [LISTS] Removed last 4 lines from markdown`);
      }

      // Save markdown to Lists folder
      const listsFolder = `${userId}/Lists/`;
      const cleanFileName = initialFileName.replace(/[^a-zA-Z0-9.-]/g, '_');
      const markdownFileName = cleanFileName.replace(/\.pdf$/i, '.md');
      const markdownBucketKey = `${listsFolder}${markdownFileName}`;

      console.log(`📝 [LISTS] Preparing to save markdown file: ${markdownBucketKey}`);
      console.log(`📝 [LISTS] Markdown length: ${fullMarkdown.length} characters`);

      // Always delete existing markdown file if it exists (to ensure fresh creation)
      try {
        const { HeadObjectCommand, DeleteObjectCommand } = await import('@aws-sdk/client-s3');
        try {
          await s3Client.send(new HeadObjectCommand({
            Bucket: bucketName,
            Key: markdownBucketKey
          }));
          // File exists - delete it
          console.log(`🗑️ [LISTS] Deleting existing markdown file: ${markdownBucketKey}`);
          await s3Client.send(new DeleteObjectCommand({
            Bucket: bucketName,
            Key: markdownBucketKey
          }));
          console.log(`✅ [LISTS] Deleted existing markdown file`);
        } catch (headErr) {
          // File doesn't exist - that's fine, we'll create it
          console.log(`ℹ️ [LISTS] No existing markdown file found - will create new one`);
        }
      } catch (deleteErr) {
        console.warn('⚠️ [LISTS] Failed to check/delete existing markdown file:', deleteErr);
        // Continue with processing even if deletion fails
      }

      // Save markdown file
      const { PutObjectCommand, HeadObjectCommand } = await import('@aws-sdk/client-s3');
      console.log(`💾 [LISTS] Attempting to save markdown to: ${markdownBucketKey} in bucket: ${bucketName}`);
      
      try {
        const putCommand = new PutObjectCommand({
          Bucket: bucketName,
          Key: markdownBucketKey,
          Body: fullMarkdown,
          ContentType: 'text/markdown',
          Metadata: {
            fileName: initialFileName,
            processedAt: new Date().toISOString(),
            userId: userId
          }
        });
        
        const putResult = await s3Client.send(putCommand);
        console.log(`💾 [LISTS] PutObjectCommand completed. Result:`, putResult ? 'success' : 'no result');
        console.log(`💾 [LISTS] Saved markdown to ${markdownBucketKey}`);
        
        // Verify the file was actually saved
        console.log(`🔍 [LISTS] Verifying file exists at ${markdownBucketKey}...`);
        try {
          const headResult = await s3Client.send(new HeadObjectCommand({
            Bucket: bucketName,
            Key: markdownBucketKey
          }));
          console.log(`✅ [LISTS] Verified markdown file exists at ${markdownBucketKey}`);
          console.log(`✅ [LISTS] File size: ${headResult.ContentLength} bytes, LastModified: ${headResult.LastModified}`);
        } catch (verifyErr) {
          console.error(`❌ [LISTS] Failed to verify markdown file was saved: ${verifyErr.message}`);
          console.error(`❌ [LISTS] Verification error details:`, verifyErr);
          throw new Error(`Markdown file was not saved successfully: ${verifyErr.message}`);
        }
      } catch (saveErr) {
        console.error(`❌ [LISTS] Failed to save markdown file: ${saveErr.message}`);
        console.error(`❌ [LISTS] Save error details:`, saveErr);
        throw new Error(`Failed to save markdown file: ${saveErr.message}`);
      }

      res.json({
        success: true,
        fileName: initialFileName,
        totalPages: result.totalPages,
        pages: result.pages,
        fullMarkdown: fullMarkdown,
        markdownBucketKey: markdownBucketKey
      });
    } catch (error) {
      console.error('❌ Error processing initial file for Lists:', error);
      res.status(500).json({ error: `Failed to process initial file: ${error.message}` });
    }
  });

  /**
   * Clean up user document references to old lists
   * POST /api/files/lists/cleanup-user-doc
   */
  app.post('/api/files/lists/cleanup-user-doc', async (req, res) => {
    try {
      // Require authentication
      const userId = req.session?.userId || req.session?.deepLinkUserId;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      // Get user document
      const userDoc = await cloudant.getDocument('maia_users', userId);
      if (!userDoc) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Remove any Lists-related fields if they exist
      // (Currently there are no Lists-specific fields in userDoc, but this is for future-proofing)
      let updated = false;
      
      // If we add Lists-specific fields later, clean them up here
      // For now, just log that cleanup was requested
      console.log(`🧹 [LISTS] Cleanup requested for user ${userId} - Lists folder was deleted`);

      if (updated) {
        await cloudant.saveDocument('maia_users', userDoc);
      }

      res.json({
        success: true,
        message: 'User document cleaned up'
      });
    } catch (error) {
      console.error('❌ Error cleaning up user document:', error);
      res.status(500).json({ error: `Failed to cleanup user document: ${error.message}` });
    }
  });

  /**
   * Get markdown file from Lists folder
   * GET /api/files/lists/markdown
   */
  app.get('/api/files/lists/markdown', async (req, res) => {
    try {
      // Require authentication
      const userId = req.session?.userId || req.session?.deepLinkUserId;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const { client: s3Client, bucketName } = getS3Client();
      const listsFolder = `${userId}/Lists/`;

      // List all files in Lists folder
      const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
      const listCommand = new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: listsFolder
      });

      const listResult = await s3Client.send(listCommand);
      
      // Log all files found for debugging
      const allFiles = (listResult.Contents || []).map(obj => ({
        key: obj.Key,
        size: obj.Size,
        lastModified: obj.LastModified
      }));
      console.log(`📂 [LISTS] Files in ${listsFolder}:`, JSON.stringify(allFiles, null, 2));
      
      // Find the most recent .md file
      const markdownFiles = (listResult.Contents || [])
        .filter(obj => obj.Key && obj.Key.endsWith('.md'))
        .sort((a, b) => (b.LastModified?.getTime() || 0) - (a.LastModified?.getTime() || 0));

      console.log(`📄 [LISTS] Found ${markdownFiles.length} markdown file(s) in Lists folder`);

      if (markdownFiles.length === 0) {
        console.log(`⚠️ [LISTS] No markdown files found in ${listsFolder}`);
        return res.json({
          success: true,
          hasMarkdown: false,
          debug: {
            listsFolder: listsFolder,
            allFiles: allFiles
          }
        });
      }

      // Get the most recent markdown file
      const latestMarkdownKey = markdownFiles[0].Key;
      console.log(`📄 [LISTS] Loading markdown file: ${latestMarkdownKey}`);
      const { GetObjectCommand } = await import('@aws-sdk/client-s3');
      const getCommand = new GetObjectCommand({
        Bucket: bucketName,
        Key: latestMarkdownKey
      });

      const response = await s3Client.send(getCommand);
      const chunks = [];
      for await (const chunk of response.Body) {
        chunks.push(chunk);
      }
      const markdown = Buffer.concat(chunks).toString('utf-8');

      console.log(`✅ [LISTS] Loaded markdown file: ${latestMarkdownKey} (${markdown.length} chars)`);

      res.json({
        success: true,
        hasMarkdown: true,
        markdown: markdown,
        markdownBucketKey: latestMarkdownKey
      });
    } catch (error) {
      console.error('❌ Error retrieving markdown file:', error);
      res.status(500).json({ error: `Failed to retrieve markdown: ${error.message}` });
    }
  });

  /**
   * Clean up markdown file - remove "Continued on Page" and "Continued from Page" lines
   * POST /api/files/lists/cleanup-markdown
   */
  app.post('/api/files/lists/cleanup-markdown', async (req, res) => {
    try {
      // Require authentication
      const userId = req.session?.userId || req.session?.deepLinkUserId;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const { client: s3Client, bucketName } = getS3Client();
      const listsFolder = `${userId}/Lists/`;

      // List all files in Lists folder
      const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
      const listCommand = new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: listsFolder
      });

      const listResult = await s3Client.send(listCommand);
      
      // Find the most recent .md file
      const markdownFiles = (listResult.Contents || [])
        .filter(obj => obj.Key && obj.Key.endsWith('.md'))
        .sort((a, b) => (b.LastModified?.getTime() || 0) - (a.LastModified?.getTime() || 0));

      if (markdownFiles.length === 0) {
        return res.status(404).json({ error: 'No markdown file found in Lists folder' });
      }

      // Get the most recent markdown file
      const markdownKey = markdownFiles[0].Key;
      const { GetObjectCommand, PutObjectCommand } = await import('@aws-sdk/client-s3');
      const getCommand = new GetObjectCommand({
        Bucket: bucketName,
        Key: markdownKey
      });

      const response = await s3Client.send(getCommand);
      const chunks = [];
      for await (const chunk of response.Body) {
        chunks.push(chunk);
      }
      let markdown = Buffer.concat(chunks).toString('utf-8');

      // Clean up page footers: Find "Health   Page nn of mm" patterns
      // Remove all lines from footer up to (but not including) next "###" line
      // Also look backward for "Continued on " lines and remove them
      // Replace with "## Page nn" where nn is the NEXT page (footer is at end of previous page)
      const pageFooterPattern = /^.*[Hh]ealth\s+[Pp]age\s+(\d+)\s+of\s+\d+.*$/;
      const continuedOnPattern = /^.*[Cc]ontinued\s+on\s+.*$/;

      let pagesCleaned = 0;
      const lines = markdown.split('\n');
      const cleanedLines = [];
      let i = 0;

      while (i < lines.length) {
        const line = lines[i];
        const trimmedLine = line.trim();
        
        // Check if current line matches "Health   Page nn of mm" pattern
        const footerMatch = trimmedLine.match(pageFooterPattern);
        
        if (footerMatch) {
          // Footer "Health   Page 32 of 133" is at the END of page 32
          // The content that follows is the START of page 33
          // So we need to use pageNum + 1 for the replacement header
          const footerPageNum = parseInt(footerMatch[1], 10);
          const nextPageNum = footerPageNum + 1;
          
          // Look backward a couple of lines for "Continued on " pattern
          let lookBackIndex = cleanedLines.length - 1;
          let foundContinuedOn = false;
          let continuedOnIndex = -1;
          let linesChecked = 0;
          
          while (lookBackIndex >= 0 && linesChecked < 3) {
            const prevTrimmed = cleanedLines[lookBackIndex].trim();
            
            if (prevTrimmed.match(continuedOnPattern)) {
              foundContinuedOn = true;
              continuedOnIndex = lookBackIndex;
              break;
            }
            
            // Skip empty lines when counting
            if (prevTrimmed !== '') {
              linesChecked++;
            }
            
            lookBackIndex--;
          }
          
          // Remove "Continued on " line if found
          if (foundContinuedOn && continuedOnIndex >= 0) {
            cleanedLines.splice(continuedOnIndex, 1);
          }
          
          // Look ahead to find the next line that starts with "###"
          let j = i + 1;
          let foundNextHeader = false;
          let nextHeaderIndex = -1;
          
          while (j < lines.length) {
            const nextTrimmed = lines[j].trim();
            
            // Check if this line starts with "###"
            if (nextTrimmed.startsWith('###')) {
              foundNextHeader = true;
              nextHeaderIndex = j;
              break;
            }
            
            j++;
          }
          
          if (foundNextHeader && nextHeaderIndex > i) {
            // Found footer and next header - remove all lines from footer to (but not including) next header
            // Replace with "## Page nn" where nn is the NEXT page (footer was at end of previous page)
            cleanedLines.push(`## Page ${nextPageNum}`);
            pagesCleaned++;
            // Skip all lines from footer to just before the next header
            i = nextHeaderIndex;
            continue;
          } else {
            // Footer found but no next header - just remove the footer line and replace with page header
            cleanedLines.push(`## Page ${nextPageNum}`);
            pagesCleaned++;
            i++;
            continue;
          }
        }
        
        // Regular line - keep it
        cleanedLines.push(line);
        i++;
      }

      let cleanedMarkdown = cleanedLines.join('\n');

      // Remove last 4 lines from markdown
      const markdownLines = cleanedMarkdown.split('\n');
      if (markdownLines.length > 4) {
        markdownLines.splice(-4);
        cleanedMarkdown = markdownLines.join('\n');
        console.log(`✂️ [LISTS] Removed last 4 lines from markdown during cleanup`);
      }

      // Save cleaned markdown back
      await s3Client.send(new PutObjectCommand({
        Bucket: bucketName,
        Key: markdownKey,
        Body: cleanedMarkdown,
        ContentType: 'text/markdown',
        Metadata: {
          cleanedAt: new Date().toISOString(),
          pagesCleaned: pagesCleaned.toString(),
          userId: userId
        }
      }));

      console.log(`🧹 [LISTS] Cleaned markdown file: ${markdownKey}`);
      console.log(`📊 [LISTS] Cleaned ${pagesCleaned} page(s) by removing page footers`);

      res.json({
        success: true,
        pagesCleaned: pagesCleaned,
        markdownBucketKey: markdownKey
      });
    } catch (error) {
      console.error('❌ Error cleaning up markdown file:', error);
      res.status(500).json({ error: `Failed to cleanup markdown: ${error.message}` });
    }
  });

  /**
   * Get saved processing results from Lists folder
   * GET /api/files/lists/results
   */
  app.get('/api/files/lists/results', async (req, res) => {
    try {
      // Require authentication (regular user or deep-link user)
      const userId = req.session?.userId || req.session?.deepLinkUserId;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const { client: s3Client, bucketName } = getS3Client();
      const listsFolder = `${userId}/Lists/`;

      // List all files in Lists folder
      const listCommand = new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: listsFolder
      });

      const listResult = await s3Client.send(listCommand);
      
      // Find the most recent _results.json file
      const resultsFiles = (listResult.Contents || [])
        .filter(obj => obj.Key && obj.Key.endsWith('_results.json'))
        .sort((a, b) => (b.LastModified?.getTime() || 0) - (a.LastModified?.getTime() || 0));

      if (resultsFiles.length === 0) {
        return res.json({
          success: true,
          hasResults: false
        });
      }

      // Get the most recent results file
      const latestResultsKey = resultsFiles[0].Key;
      const getCommand = new GetObjectCommand({
        Bucket: bucketName,
        Key: latestResultsKey
      });

      const response = await s3Client.send(getCommand);
      const chunks = [];
      for await (const chunk of response.Body) {
        chunks.push(chunk);
      }
      const resultsJson = Buffer.concat(chunks).toString('utf-8');
      const processingResults = JSON.parse(resultsJson);

      // Find the corresponding PDF file
      const pdfFileName = processingResults.fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
      const pdfKey = `${listsFolder}${pdfFileName}`;

      res.json({
        success: true,
        hasResults: true,
        pdfBucketKey: pdfKey,
        resultsBucketKey: latestResultsKey,
        results: processingResults
      });
    } catch (error) {
      console.error('❌ Error retrieving Lists processing results:', error);
      res.status(500).json({ error: `Failed to retrieve results: ${error.message}` });
    }
  });

  /**
   * Index clinical notes from PDF markdown
   * POST /api/files/index-clinical-notes
   */
  app.post('/api/files/index-clinical-notes', upload.single('pdfFile'), async (req, res) => {
    try {
      // Require authentication
      const userId = req.session?.userId || req.session?.deepLinkUserId;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const notesClient = getClinicalNotesClient();
      if (!notesClient) {
        return res.status(503).json({ 
          error: 'Clinical Notes indexing not configured',
          message: 'OPENSEARCH_ENDPOINT environment variable is required'
        });
      }

      if (!req.file) {
        return res.status(400).json({ error: 'No PDF file provided' });
      }

      // Security checks
      if (req.file.size === 0) {
        return res.status(400).json({ error: 'Empty file provided' });
      }
      
      if (req.file.size > 50 * 1024 * 1024) {
        return res.status(400).json({ error: 'File too large (max 50MB)' });
      }

      // Extract PDF with page boundaries
      const result = await extractPdfWithPages(req.file.buffer);
      const fileName = req.file.originalname;

      // Extract categories using Private AI if available
      const fullMarkdown = result.pages.map(p => `## Page ${p.page}\n\n${p.markdown}`).join('\n\n---\n\n');
      let categories = [];
      
      if (cloudant && doClient) {
        try {
          categories = await extractMarkdownCategories(fullMarkdown, userId, cloudant, doClient);
        } catch (error) {
          // Failed to extract categories, continuing without them
        }
      }

      // Prepare notes for indexing
      // Each page becomes a note, and we can also create notes per category
      const notesToIndex = [];
      
      // Index each page as a note
      for (const page of result.pages) {
        // Find category for this page (if available)
        const pageCategory = categories.find(cat => 
          fullMarkdown.substring(0, fullMarkdown.indexOf(`## Page ${page.page}`)).includes(`### ${cat.category}`)
        )?.category || '';

        notesToIndex.push({
          fileName: fileName,
          page: page.page,
          category: pageCategory,
          content: page.text,
          markdown: page.markdown
        });
      }

      // Bulk index all notes
      const bulkResult = await notesClient.indexNotesBulk(userId, notesToIndex);

      res.json({
        success: true,
        indexed: bulkResult.indexed,
        errors: bulkResult.errors || [],
        fileName: fileName,
        totalPages: result.totalPages,
        categories: categories
      });
    } catch (error) {
      console.error('Error indexing clinical notes:', error);
      res.status(500).json({ error: `Failed to index clinical notes: ${error.message}` });
    }
  });

  /**
   * Index clinical notes from bucket file
   * POST /api/files/index-clinical-notes/:bucketKey(*)
   */
  app.post('/api/files/index-clinical-notes/:bucketKey(*)', async (req, res) => {
    try {
      // Require authentication
      const userId = req.session?.userId || req.session?.deepLinkUserId;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const notesClient = getClinicalNotesClient();
      if (!notesClient) {
        return res.status(503).json({ 
          error: 'Clinical Notes indexing not configured',
          message: 'OPENSEARCH_ENDPOINT environment variable is required'
        });
      }

      const { bucketKey } = req.params;
      
      const bucketUrl = process.env.DIGITALOCEAN_BUCKET;
      const bucketName = bucketUrl?.split('//')[1]?.split('.')[0] || 'maia';

      const s3Client = new S3Client({
        endpoint: process.env.DIGITALOCEAN_ENDPOINT_URL || 'https://tor1.digitaloceanspaces.com',
        region: 'us-east-1',
        forcePathStyle: false,
        credentials: {
          accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID || '',
          secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY || ''
        }
      });

      const getCommand = new GetObjectCommand({
        Bucket: bucketName,
        Key: bucketKey
      });
      
      const response = await s3Client.send(getCommand);
      
      // Read the PDF file content
      const chunks = [];
      for await (const chunk of response.Body) {
        chunks.push(chunk);
      }
      const pdfBuffer = Buffer.concat(chunks);
      const fileName = bucketKey.split('/').pop() || 'unknown.pdf';

      // Extract PDF with page boundaries
      const result = await extractPdfWithPages(pdfBuffer);
      const fullMarkdown = result.pages.map(p => `## Page ${p.page}\n\n${p.markdown}`).join('\n\n---\n\n');

      // Extract categories using Private AI if available
      let categories = [];
      if (cloudant && doClient) {
        try {
          categories = await extractMarkdownCategories(fullMarkdown, userId, cloudant, doClient);
        } catch (error) {
          // Failed to extract categories, continuing without them
        }
      }

      // Prepare notes for indexing
      const notesToIndex = [];
      
      for (const page of result.pages) {
        // Find category for this page (if available)
        const pageCategory = categories.find(cat => 
          fullMarkdown.substring(0, fullMarkdown.indexOf(`## Page ${page.page}`)).includes(`### ${cat.category}`)
        )?.category || '';

        notesToIndex.push({
          fileName: fileName,
          page: page.page,
          category: pageCategory,
          content: page.text,
          markdown: page.markdown
        });
      }

      // Bulk index all notes
      const bulkResult = await notesClient.indexNotesBulk(userId, notesToIndex);

      res.json({
        success: true,
        indexed: bulkResult.indexed,
        errors: bulkResult.errors || [],
        fileName: fileName,
        totalPages: result.totalPages,
        categories: categories
      });
    } catch (error) {
      console.error('Error indexing clinical notes:', error);
      res.status(500).json({ error: `Failed to index clinical notes: ${error.message}` });
    }
  });

  /**
   * Search clinical notes
   * POST /api/files/search-clinical-notes
   */
  app.post('/api/files/search-clinical-notes', async (req, res) => {
    try {
      // Require authentication
      const userId = req.session?.userId || req.session?.deepLinkUserId;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const notesClient = getClinicalNotesClient();
      if (!notesClient) {
        return res.status(503).json({ 
          error: 'Clinical Notes search not configured',
          message: 'OPENSEARCH_ENDPOINT environment variable is required'
        });
      }

      const { query, category, fileName, page, size, from } = req.body;

      // Search notes (userId is automatically enforced by the client)
      const searchResult = await notesClient.searchNotes(userId, {
        query: query,
        category: category,
        fileName: fileName,
        page: page,
        size: size || 100,
        from: from || 0
      });

      res.json({
        success: true,
        total: searchResult.total,
        hits: searchResult.hits
      });
    } catch (error) {
      console.error('Error searching clinical notes:', error);
      res.status(500).json({ error: `Failed to search clinical notes: ${error.message}` });
    }
  });

  /**
   * Get all clinical notes for the authenticated user
   * GET /api/files/clinical-notes
   */
  app.get('/api/files/clinical-notes', async (req, res) => {
    try {
      // Require authentication
      const userId = req.session?.userId || req.session?.deepLinkUserId;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const notesClient = getClinicalNotesClient();
      if (!notesClient) {
        return res.status(503).json({ 
          error: 'Clinical Notes not configured',
          message: 'OPENSEARCH_ENDPOINT environment variable is required'
        });
      }

      // Get all notes for the user (match all query)
      // Don't sort by date in OpenSearch since it might not be sortable in existing indices
      const searchResult = await notesClient.searchNotes(userId, {
        query: '*', // Match all
        size: 10000, // Get up to 10,000 notes
        from: 0
        // Sort will be done in JavaScript after fetching
      });

      // Extract relevant fields: type, author, category, created
      const notes = searchResult.hits.map(hit => {
        const source = hit.source;
        
        // Use stored fields if available, otherwise extract from markdown
        const type = source.type || '';
        const author = source.author || '';
        const category = source.category || '';
        const created = source.created || '';
        const date = source.date || '';

        return {
          id: hit.id,
          type: type,
          author: author,
          category: category,
          created: created,
          date: date,
          fileName: source.fileName || '',
          page: source.page || 0
        };
      });

      // Sort by date (newest first) in JavaScript
      // Parse dates for proper sorting (handle various formats)
      notes.sort((a, b) => {
        // If both have dates, try to parse and compare
        if (a.date && b.date) {
          // Try to parse dates - handle formats like "Oct 27, 2025", "10/27/2025", etc.
          const dateA = parseDate(a.date);
          const dateB = parseDate(b.date);
          if (dateA && dateB) {
            return dateB.getTime() - dateA.getTime(); // Newest first
          }
          // If parsing fails, do string comparison
          return b.date.localeCompare(a.date);
        }
        // If only one has a date, prioritize it
        if (a.date && !b.date) return -1;
        if (!a.date && b.date) return 1;
        // If neither has a date, sort by page (newest first)
        return b.page - a.page;
      });

      res.json({
        success: true,
        total: searchResult.total,
        notes: notes
      });
    } catch (error) {
      console.error('Error fetching clinical notes:', error);
      res.status(500).json({ error: `Failed to fetch clinical notes: ${error.message}` });
    }
  });

  /**
   * Get categories for user's clinical notes
   * GET /api/files/clinical-notes-categories
   */
  app.get('/api/files/clinical-notes-categories', async (req, res) => {
    try {
      // Require authentication
      const userId = req.session?.userId || req.session?.deepLinkUserId;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const notesClient = getClinicalNotesClient();
      if (!notesClient) {
        return res.status(503).json({ 
          error: 'Clinical Notes not configured',
          message: 'OPENSEARCH_ENDPOINT environment variable is required'
        });
      }

      const categories = await notesClient.getCategories(userId);

      res.json({
        success: true,
        categories: categories
      });
    } catch (error) {
      console.error('Error getting categories:', error);
      res.status(500).json({ error: `Failed to get categories: ${error.message}` });
    }
  });

  /**
   * POST /api/files/lists/current-medications
   * Get current medications from Medication Records using Private AI
   */
  app.post('/api/files/lists/current-medications', async (req, res) => {
    try {
      const userId = req.session?.userId || req.session?.deepLinkUserId;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const { medicationRecords } = req.body;

      if (!medicationRecords || !Array.isArray(medicationRecords)) {
        return res.status(400).json({ error: 'medicationRecords array is required' });
      }

      // Get user document to access agent info
      const userDoc = await cloudant.getDocument('maia_users', userId);
      
      if (!userDoc || !userDoc.assignedAgentId || !userDoc.agentEndpoint) {
        return res.status(400).json({ error: 'Private AI agent not configured for user' });
      }

      // Import DigitalOcean provider
      const { DigitalOceanProvider } = await import('../../lib/chat-client/providers/digitalocean.js');
      const { getOrCreateAgentApiKey } = await import('../utils/agent-helper.js');
      
      // Get or create API key
      const apiKey = await getOrCreateAgentApiKey(doClient, cloudant, userId, userDoc.assignedAgentId);
      
      // Create provider
      const agentProvider = new DigitalOceanProvider(apiKey, {
        baseURL: userDoc.agentEndpoint
      });

      // Format medication records for the prompt
      const medicationsText = medicationRecords.map((obs, idx) => {
        return `${idx + 1}. ${obs.display || obs.date || 'Unknown medication'}`;
      }).join('\n');

      // Create prompt
      const prompt = `What are the current medications from this list?\n\n${medicationsText}\n\nPlease list only the medications that are currently active or being taken. Format your response as a clear, readable list.`;

      console.log(`🤖 [LISTS] Calling Private AI to identify current medications for user ${userId}`);

      // Call the agent
      const response = await agentProvider.chat(
        [{ role: 'user', content: prompt }],
        { 
          model: userDoc.agentModelName || 'openai-gpt-oss-120b',
          stream: false
        }
      );

      const aiResponse = response.content || response.text || '';
      
      if (!aiResponse || aiResponse.trim().length === 0) {
        return res.status(500).json({ error: 'Empty response from Private AI' });
      }

      console.log(`✅ [LISTS] Received current medications response from Private AI`);

      res.json({
        success: true,
        currentMedications: aiResponse.trim()
      });
    } catch (error) {
      console.error('❌ [LISTS] Error getting current medications:', error);
      res.status(500).json({ error: `Failed to get current medications: ${error.message}` });
    }
  });
}

