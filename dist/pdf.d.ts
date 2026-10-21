export interface PdfOptions {
    pdfCommand: string;
    pdfTimeoutMs: number;
    maxPdfPages: number;
    maxPdfBytes: number;
}
export declare const DEFAULT_PDF_OPTIONS: PdfOptions;
export interface PdfText {
    content: string;
    truncated: boolean;
}
export declare function validatePdfOptions(options: PdfOptions): void;
/** Decode already validated, completely downloaded PDF bytes in a cancellable local process. */
export declare function extractPdfText(bytes: Uint8Array, maxChars: number, signal: AbortSignal, options: PdfOptions): Promise<PdfText>;
