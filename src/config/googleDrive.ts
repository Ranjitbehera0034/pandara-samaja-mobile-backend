import fs from 'fs';
import { Readable } from 'stream';
import { google } from 'googleapis';
import mime from 'mime-types';
import dotenv from 'dotenv';
dotenv.config();

const FOLDER_ID = process.env.DRIVE_FOLDER_ID;
if (!FOLDER_ID) {
  console.warn('⚠️ DRIVE_FOLDER_ID is not set. File uploads will fail.');
}

let drive: any;

// STRATEGY 1: OAuth2 (Recommended for Personal Accounts)
if (process.env.GOOGLE_REFRESH_TOKEN && process.env.GOOGLE_CLIENT_ID) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || 'https://developers.google.com/oauthplayground'
  );
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  drive = google.drive({ version: 'v3', auth: oauth2Client });

} else {
  // STRATEGY 2: Service Account (Recommended for Workspace/Organizations)
  let credentials;
  if (process.env.GOOGLE_CREDENTIALS) {
    try {
      credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    } catch (err) {
      console.error('Failed to parse GOOGLE_CREDENTIALS env var:', err);
    }
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive']
  });
  drive = google.drive({ version: 'v3', auth });
}

/**
 * Uploads a file (Buffer or on-disk) to Google Drive, makes it public,
 * and returns a direct link.
 */
export async function uploadFile(file: { originalname: string; buffer?: Buffer; path?: string }): Promise<string> {
  if (!file || !file.originalname) {
    throw new Error('Invalid file object passed to uploadFile');
  }

  let stream: any;
  if (file.buffer) {
    stream = Readable.from(file.buffer);
  } else if (file.path) {
    stream = fs.createReadStream(file.path);
  } else {
    throw new Error('Invalid file object passed to uploadFile');
  }

  const createReqBody: any = {
    name: file.originalname,
  };

  if (FOLDER_ID) {
    createReqBody.parents = [FOLDER_ID];
  }

  const res = await drive.files.create({
    requestBody: createReqBody,
    media: {
      mimeType: mime.lookup(file.originalname) || 'application/octet-stream',
      body: stream
    },
    fields: 'id'
  });

  const fileId = res.data.id;

  if (!fileId) {
    throw new Error('Failed to retrieve file ID from Google Drive upload response');
  }

  // Make it public
  await drive.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' }
  });

  // Cleanup local file if on disk
  if (file.path) {
    fs.unlink(file.path, err => {
      if (err) console.warn('Failed to delete temp file:', file.path, err);
    });
  }

  return `https://lh3.googleusercontent.com/d/${fileId}`;
}
