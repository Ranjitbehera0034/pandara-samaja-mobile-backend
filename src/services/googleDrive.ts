import { google } from 'googleapis';
import { Readable } from 'stream';

const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  },
  scopes: ['https://www.googleapis.com/auth/drive'],
});

const drive = google.drive({ version: 'v3', auth });

const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || '';

/**
 * Upload a file buffer to Google Drive
 * Returns the public URL
 */
export const uploadFile = async (file: {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
}): Promise<string> => {
  const stream = Readable.from(file.buffer);

  const response = await drive.files.create({
    requestBody: {
      name: `${Date.now()}_${file.originalname}`,
      mimeType: file.mimetype,
      parents: [FOLDER_ID],
    },
    media: {
      mimeType: file.mimetype,
      body: stream,
    },
    fields: 'id, webViewLink, webContentLink',
  });

  const fileId = response.data.id;
  if (!fileId) throw new Error('Google Drive upload failed — no file ID returned');

  // Make file publicly readable
  await drive.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' },
  });

  // Return the lh3 proxy URL (same transform as web portal)
  return `https://lh3.googleusercontent.com/d/${fileId}`;
};

/**
 * Delete a file from Google Drive by URL
 */
export const deleteFile = async (url: string): Promise<void> => {
  try {
    // Extract file ID from URL
    const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (!match) return;
    const fileId = match[1];
    await drive.files.delete({ fileId });
  } catch (e) {
    console.error('[GDRIVE] Delete error:', e);
  }
};
