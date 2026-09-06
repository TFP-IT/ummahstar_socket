const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { S3Client, PutObjectCommand, HeadBucketCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { v4: uuidv4 } = require('uuid');

/**
 * MIME type resolver based on extension or messageType fallback
 */
function getMimeType(fileName, messageType) {
  const ext = (path.extname(fileName || '')).toLowerCase();
  const mimeMap = {
    // Images
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.bmp': 'image/bmp',

    // Audio
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',

    // Video
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska',
    '.webm': 'video/webm',
    '.3gp': 'video/3gpp',

    // Documents
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.txt': 'text/plain',
    '.zip': 'application/zip',
  };

  if (mimeMap[ext]) {
    return mimeMap[ext];
  }

  switch (messageType) {
    case 'image':
      return 'image/jpeg';
    case 'audio':
      return 'audio/mp4';
    case 'video':
      return 'video/mp4';
    case 'document':
    case 'file':
      return 'application/octet-stream';
    default:
      return 'application/octet-stream';
  }
}

function createS3UploadService({ baseDir }) {
  const region = process.env.AWS_REGION || 'ap-southeast-1';
  const bucket = process.env.AWS_S3_BUCKET || process.env.AWS_BUCKET_NAME || '';
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID || '';
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || '';

  // CloudFront or S3 custom base domain
  const cdnUrl = (
    process.env.AWS_CDN_URL ||
    process.env.CLOUDFRONT_URL ||
    process.env.AWS_CLOUDFRONT_DOMAIN ||
    (bucket ? `https://${bucket}.s3.${region}.amazonaws.com` : '')
  ).replace(/\/$/, '');

  const isConfigured = Boolean(bucket && accessKeyId && secretAccessKey);

  let s3Client = null;
  if (isConfigured) {
    s3Client = new S3Client({
      region,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });
    console.log(`[S3UploadService] Initialized S3 client for bucket "${bucket}" (Region: ${region})`);
    if (cdnUrl) {
      console.log(`[S3UploadService] Public Media Base URL: ${cdnUrl}`);
    }
  } else {
    console.warn('[S3UploadService] AWS S3 credentials not fully configured in .env. Will fallback to local storage.');
  }

  const rootFolder = (process.env.AWS_S3_FOLDER || 'salambox').replace(/^\/+|\/+$/g, '');

  function getFolderForType(messageType) {
    switch (messageType) {
      case 'image':
        return 'images';
      case 'audio':
        return 'audio';
      case 'video':
        return 'videos';
      case 'document':
      case 'file':
        return 'documents';
      default:
        return messageType || 'files';
    }
  }

  /**
   * Automatically process and compress images to high-performance WebP
   */
  async function processImageToWebp(fileBuffer, originalFileName) {
    const ext = (path.extname(originalFileName || '')).toLowerCase();
    // Keep animated GIFs and SVGs as-is
    if (ext === '.gif' || ext === '.svg') {
      return {
        buffer: fileBuffer,
        extension: ext,
        contentType: ext === '.gif' ? 'image/gif' : 'image/svg+xml',
      };
    }

    try {
      const webpBuffer = await sharp(fileBuffer)
        .rotate() // Auto-orient based on EXIF camera metadata
        .resize({
          width: 1920,
          height: 1920,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: 80, effort: 4 })
        .toBuffer();

      return {
        buffer: webpBuffer,
        extension: '.webp',
        contentType: 'image/webp',
      };
    } catch (error) {
      console.warn('[S3UploadService] WebP conversion fallback, using original:', error.message);
      return {
        buffer: fileBuffer,
        extension: ext || '.jpg',
        contentType: getMimeType(originalFileName, 'image'),
      };
    }
  }

  /**
   * Fallback: Save to local uploads/ directory
   */
  async function saveToLocalDisk({ uuid, fileName, fileData, messageType }) {
    const uploadDirectory = path.join(baseDir, 'uploads', messageType || 'file');
    if (!fs.existsSync(uploadDirectory)) {
      fs.mkdirSync(uploadDirectory, { recursive: true });
    }

    let finalBuffer = Buffer.from(fileData, 'base64');
    let finalExtension = path.extname(fileName || '');

    if (messageType === 'image') {
      const processed = await processImageToWebp(finalBuffer, fileName);
      finalBuffer = processed.buffer;
      finalExtension = processed.extension;
    }

    const uniqueFileName = `${uuid || uuidv4()}${finalExtension}`;
    const filePath = path.join(uploadDirectory, uniqueFileName);

    fs.writeFileSync(filePath, finalBuffer);

    return {
      fileName: uniqueFileName,
      filePath,
      fileUrl: `uploads/${messageType || 'file'}/${uniqueFileName}`,
      storage: 'local',
    };
  }

  /**
   * Upload Base64 Buffer directly to AWS S3 (Images converted to WebP)
   */
  async function uploadBase64File({ uuid, fileName, fileData, messageType }) {
    if (!isConfigured || !s3Client) {
      return await saveToLocalDisk({ uuid, fileName, fileData, messageType });
    }

    let finalBuffer = Buffer.from(fileData, 'base64');
    let finalExtension = path.extname(fileName || '');
    let contentType = getMimeType(fileName, messageType);

    // Convert chat images to lightweight, crisp WebP
    if (messageType === 'image') {
      const processed = await processImageToWebp(finalBuffer, fileName);
      finalBuffer = processed.buffer;
      finalExtension = processed.extension;
      contentType = processed.contentType;
    }

    const uniqueFileName = `${uuid || uuidv4()}${finalExtension}`;
    const folder = getFolderForType(messageType);

    // Folder structure: salambox/<folder>/<YYYY-MM>/<uuid>.<ext>
    const datePrefix = new Date().toISOString().slice(0, 7); // e.g. "2026-09"
    const s3Key = `${rootFolder}/${folder}/${datePrefix}/${uniqueFileName}`;

    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: s3Key,
      Body: finalBuffer,
      ContentType: contentType,
    });

    await s3Client.send(command);

    const fullUrl = `${cdnUrl}/${s3Key}`;

    return {
      fileName: uniqueFileName,
      s3Key,
      fileUrl: fullUrl,
      storage: 's3',
      isWebp: messageType === 'image' && finalExtension === '.webp',
    };
  }

  /**
   * Generate Pre-signed PUT URL for direct mobile/client upload to S3
   * Valid for 15 minutes
   */
  async function generatePresignedUploadUrl({ fileName, messageType, fileType, uuid }) {
    if (!isConfigured || !s3Client) {
      throw new Error('S3 is not configured on server');
    }

    const fileExtension = path.extname(fileName || '');
    const uniqueFileName = `${uuid || uuidv4()}${fileExtension}`;
    const folder = getFolderForType(messageType);
    const datePrefix = new Date().toISOString().slice(0, 7);
    const s3Key = `${rootFolder}/${folder}/${datePrefix}/${uniqueFileName}`;

    const contentType = fileType || getMimeType(fileName, messageType);

    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: s3Key,
      ContentType: contentType,
    });

    const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 900 });

    return {
      uploadUrl,
      s3Key,
      fileName: uniqueFileName,
      fileUrl: `${cdnUrl}/${s3Key}`,
      contentType,
    };
  }

  return {
    isConfigured,
    uploadBase64File,
    generatePresignedUploadUrl,
    saveToLocalDisk,
    getMimeType,
  };
}

module.exports = {
  createS3UploadService,
};
