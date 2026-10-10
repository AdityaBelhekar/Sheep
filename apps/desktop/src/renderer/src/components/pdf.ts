/**
 * pdf.js, with its worker.
 *
 * Imported dynamically by `PdfPreview`, so none of it is loaded until a PDF is
 * actually shown. The worker is bundled and served from the app itself: the
 * content-security policy allows scripts from nowhere else.
 */
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker';

GlobalWorkerOptions.workerPort = new PdfWorker();

export { getDocument };
