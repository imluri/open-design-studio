import type { DesignPage } from '../model';

/** Parsed local Canva export. Images are embedded and no source URLs are retained. */
export interface CanvaPageSet {
  title: string;
  width: number;
  height: number;
  pages: DesignPage[];
  warnings: string[];
}

export interface CanvaImportSummary {
  pages: number;
  editableElements: number;
  imageElements: number;
  warnings: string[];
}
