const {createS3UploadService} = require('./s3UploadService');

function createUploadService({baseDir}) {
  const s3Service = createS3UploadService({baseDir});

  async function saveBase64File({uuid, fileName, fileData, messageType}) {
    return await s3Service.uploadBase64File({
      uuid,
      fileName,
      fileData,
      messageType,
    });
  }

  async function generatePresignedUploadUrl(params) {
    return await s3Service.generatePresignedUploadUrl(params);
  }

  return {
    saveBase64File,
    generatePresignedUploadUrl,
    s3Service,
  };
}

module.exports = {
  createUploadService,
};
