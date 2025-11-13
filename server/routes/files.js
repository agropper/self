/**
 * File upload and management routes
 * Handles PDF parsing, bucket uploads, and file metadata
 */

import multer from 'multer';
import pdf from 'pdf-parse';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// Configure multer for file uploads (in memory)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB limit
  }
});

export default function setupFileRoutes(app) {
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

      // New imports go to root userId level (not archived yet)
      const userFolder = `${userId}/`;
      const fileName = req.file.originalname;
      
      // Generate a unique key for the file
      const cleanName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
      const bucketKey = `${userFolder}${cleanName}`;

      // Setup S3/Spaces client
      const bucketUrl = process.env.DIGITALOCEAN_BUCKET;
      if (!bucketUrl) {
        return res.status(500).json({
          error: 'DigitalOcean bucket not configured',
          error: 'BUCKET_NOT_CONFIGURED'
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
      
      console.log(`📄 Proxying PDF file with bucket key: ${bucketKey}`);
      
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
      
      console.log(`📄 Fetching from S3: ${bucketName}/${bucketKey}`);
      
      const response = await s3Client.send(getCommand);
      
      // Set appropriate headers
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${bucketKey.split('/').pop()}"`);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      
      // Stream the PDF content
      response.Body.pipe(res);
      
      console.log(`✅ Successfully streaming PDF: ${bucketKey}`);
    } catch (error) {
      console.error('❌ Error proxying PDF:', error);
      res.status(500).json({ 
        success: false,
        error: `Failed to proxy PDF: ${error.message}` 
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
}

