const fs = require('fs');
const path = require('path');
const {v4: uuidv4} = require('uuid');

function createUploadService({baseDir}) {
  function ensureUploadsDirectory(messageType) {
    const uploadDirectory = path.join(baseDir, 'uploads', messageType);

    if (!fs.existsSync(uploadDirectory)) {
      fs.mkdirSync(uploadDirectory, {recursive: true});
    }

    return uploadDirectory;
  }

  function saveBase64File({uuid, fileName, fileData, messageType}) {
    const uploadDirectory = ensureUploadsDirectory(messageType);
    const fileExtension = path.extname(fileName);
    const uniqueFileName = `${uuid || uuidv4()}${fileExtension}`;
    const filePath = path.join(uploadDirectory, uniqueFileName);

    fs.writeFileSync(filePath, fileData, 'base64');

    if (!fs.existsSync(filePath)) {
      throw new Error('File was not created');
    }

    return {
      fileName: uniqueFileName,
      filePath,
      fileUrl: `uploads/${messageType}/${uniqueFileName}`,
    };
  }

  return {
    ensureUploadsDirectory,
    saveBase64File,
  };
}

module.exports = {
  createUploadService,
};
