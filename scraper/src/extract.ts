// Text extraction from a downloaded notice PDF. Verified directly against
// two real OSSC notices: pdf-parse extracted ZERO text from both — these
// aren't standard extractable-text PDFs, so the OCR path below is the
// PRIMARY path for this source in practice, not a rare fallback. OCR
// output has visible errors (digit/spacing corruption); see README.md for
// why that's mitigated by admin review rather than "fixed" here.
import pdfParse from 'pdf-parse';
import { createWorker } from 'tesseract.js';
// Imported lazily inside ocrExtraction(), not here — pdf-to-img's
// dependency chain (pdfjs-dist's legacy build) contains a top-level await
// that tsx's CJS transform can't handle, and a static import crashes the
// whole module graph at load time even when OCR is never invoked. A
// dynamic import defers that to the (rare, unverified) OCR fallback path
// itself instead of breaking the common text-PDF case. See README.md.

const MIN_TEXT_LENGTH = 50;

export async function extractText(pdfBuffer: Buffer): Promise<string> {
  const direct = await tryDirectExtraction(pdfBuffer);
  if (direct && direct.trim().length >= MIN_TEXT_LENGTH) {
    return direct.trim();
  }

  console.log('[extract] Direct text extraction too short — falling back to OCR');
  return ocrExtraction(pdfBuffer);
}

async function tryDirectExtraction(pdfBuffer: Buffer): Promise<string | null> {
  try {
    const result = await pdfParse(pdfBuffer);
    return result.text;
  } catch (err) {
    console.error('[extract] pdf-parse failed:', (err as Error).message);
    return null;
  }
}

async function ocrExtraction(pdfBuffer: Buffer): Promise<string> {
  const { pdf: pdfToImages } = await import('pdf-to-img');
  const worker = await createWorker('eng');
  try {
    const pages: string[] = [];
    const document = await pdfToImages(pdfBuffer);
    for await (const pageImage of document) {
      const { data } = await worker.recognize(pageImage);
      pages.push(data.text);
      if (pages.length >= 5) break; // notices rarely exceed a few pages; cap OCR cost
    }
    return pages.join('\n\n').trim();
  } finally {
    await worker.terminate();
  }
}
