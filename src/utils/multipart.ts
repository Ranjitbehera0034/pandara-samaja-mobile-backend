import { FastifyRequest } from 'fastify';

export interface MultipartFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
}

/**
 * Drains a multipart request into plain field values and named file
 * buffers, grouped by fieldname. Shared by any route that needs both text
 * fields and one-or-more files (possibly under different field names) in
 * the same multipart body — feed posts/stories, family albums, matrimony
 * candidate profiles (form document + photos).
 */
export async function readMultipartFiles(
  req: FastifyRequest,
  fieldnames: string[]
): Promise<{ files: Record<string, MultipartFile[]>; fields: Record<string, string> }> {
  const files: Record<string, MultipartFile[]> = {};
  for (const name of fieldnames) files[name] = [];
  const fields: Record<string, string> = {};

  const parts = (req as any).parts();
  for await (const part of parts) {
    if (part.type === 'field') {
      fields[part.fieldname] = part.value as string;
    } else if (part.type === 'file' && fieldnames.includes(part.fieldname)) {
      const chunks: Buffer[] = [];
      for await (const chunk of part.file) chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      if (buffer.length > 0) {
        files[part.fieldname].push({ buffer, originalname: part.filename || 'upload', mimetype: part.mimetype });
      }
    }
  }
  return { files, fields };
}
