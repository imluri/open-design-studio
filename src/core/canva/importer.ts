import { DESIGN_FORMAT, DESIGN_VERSION, DESIGN_MAX_PAGES, DESIGN_MAX_TOTAL_IMAGE_BYTES, DESIGN_MAX_TOTAL_ELEMENTS, PROJECT_MAX_FILE_BYTES, validateProject, type Project } from '../model';
import { importImage } from '../canvas';
import type { CanvaImportSummary, CanvaPageSet } from './types';

export interface CanvaImportResult { project: Project; summary: CanvaImportSummary }
const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml' };
const extension = (name: string) => name.split('.').pop()?.toLowerCase() ?? '';
const titleOf = (name: string) => name.replace(/\.(?:canva-import\.)?[a-z0-9]+$/i, '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 150) || 'Imported Canva design';
const errorText = (caught: unknown) => caught instanceof Error ? caught.message : 'This export could not be imported.';

function canvasSize(width: number, height: number) {
  if (!width || !height) throw new Error('This export has no usable page dimensions.');
  const scale = Math.min(1, 4096 / Math.max(width, height));
  let w = Math.round(width * scale), h = Math.round(height * scale);
  if (Math.min(w, h) < 320) { const up = 320 / Math.min(w, h); w = Math.round(w * up); h = Math.round(h * up); }
  if (Math.max(w, h) > 4096) throw new Error('This page is too narrow or tall. Export a page with an aspect ratio below 12.8:1.');
  return { width: w, height: h };
}

async function rasterPage(file: File): Promise<CanvaPageSet> {
  const image = await importImage(file), size = canvasSize(image.width, image.height);
  return {
    title: titleOf(file.name), ...size,
    pages: [{ id: crypto.randomUUID(), name: titleOf(file.name), background: '#FFFFFF', elements: [{ id: crypto.randomUUID(), name: 'Imported page artwork', type: 'image', src: image.src, x: 0, y: 0, width: size.width, height: size.height, rotation: 0, opacity: 1, visible: true, locked: false }] }],
    warnings: ['PNG, JPG and WebP exports are flattened artwork. Their text and shapes remain inside the image.'],
  };
}

async function unpackTransfer(file: File): Promise<File> {
  if (file.size > PROJECT_MAX_FILE_BYTES) throw new Error('Choose a Canva transfer file under 50 MB.');
  let value: unknown;
  try { value = JSON.parse(await file.text()); } catch { throw new Error('This is not a valid Canva bridge transfer file.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Choose a .canva-import.json file from the Canva bridge.');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['format', 'version', 'name', 'mimeType', 'data'].includes(key)) || input.format !== 'open-design-studio-canva-transfer' || input.version !== 1 || typeof input.name !== 'string' || !input.name.length || input.name.length > 240 || /[\u0000-\u001f\u007f/\\]/.test(input.name) || typeof input.mimeType !== 'string' || input.mimeType.length > 150 || typeof input.data !== 'string' || input.data.length > 42 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.data) || input.data.length % 4) throw new Error('This Canva transfer file has invalid or unsupported contents.');
  const type = extension(input.name);
  if (!['pptx', 'svg', 'png', 'jpg', 'jpeg', 'webp', 'zip'].includes(type)) throw new Error('The bridge contains an unsupported export type.');
  let decoded: string;
  try { decoded = atob(input.data); } catch { throw new Error('The Canva transfer file is damaged.'); }
  if (!decoded.length || decoded.length > 30 * 1024 * 1024) throw new Error('Canva bridge exports must be under 30 MB.');
  const bytes = Uint8Array.from(decoded, character => character.charCodeAt(0));
  return new File([bytes], input.name, { type: IMAGE_TYPES[type] ?? (type === 'zip' ? 'application/zip' : 'application/vnd.openxmlformats-officedocument.presentationml.presentation') });
}

async function unpackPages(file: File): Promise<File[]> {
  if (file.size > PROJECT_MAX_FILE_BYTES) throw new Error('Choose a Canva ZIP under 50 MB.');
  const { unpackCanvaZip } = await import('./pptx');
  const selected = new Set<string>(); let count = 0;
  try {
    const entries = await unpackCanvaZip(file, name => {
      if (++count > 200 || name.length > 240) throw new Error('This image ZIP has too many entries or an oversized file name.');
      const take = !name.split('/').some(part => part.startsWith('.')) && !name.startsWith('__MACOSX/') && Boolean(IMAGE_TYPES[extension(name)]);
      if (take) { selected.add(name); if (selected.size > DESIGN_MAX_PAGES) throw new Error('Import at most 12 pages at once.'); }
      return take;
    });
    return [...entries.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })).map(name => new File([new Uint8Array(entries.get(name)!)], name.split('/').pop()!, { type: IMAGE_TYPES[extension(name)] }));
  } catch (caught) { throw new Error(`The Canva ZIP could not be opened. ${errorText(caught)}`); }
}

async function parse(file: File): Promise<CanvaPageSet> {
  if (!file.size || file.size > PROJECT_MAX_FILE_BYTES) throw new Error('Choose a non-empty Canva export under 50 MB.');
  const type = extension(file.name);
  if (type === 'pptx') return (await import('./pptx')).importCanvaPptx(file);
  if (type === 'svg') return (await import('./svg')).importCanvaSvg(file);
  if (['png', 'jpg', 'jpeg', 'webp'].includes(type)) return rasterPage(file);
  throw new Error('Choose a Canva PPTX, SVG, PNG, JPG, WebP, image ZIP or bridge transfer file.');
}

/** All parsing is local. A preview is returned before the current project changes. */
export async function importCanvaFiles(input: File[]): Promise<CanvaImportResult> {
  if (!input.length) throw new Error('Choose a Canva export to import.');
  if (input.length > DESIGN_MAX_PAGES || input.reduce((sum, file) => sum + file.size, 0) > PROJECT_MAX_FILE_BYTES) throw new Error('Choose up to 12 files totalling no more than 50 MB.');
  let files = input;
  if (files.length === 1 && extension(files[0].name) === 'json') files = [await unpackTransfer(files[0])];
  let title = titleOf(files[0].name);
  if (files.length === 1 && extension(files[0].name) === 'zip') files = await unpackPages(files[0]);
  if (!files.length) throw new Error('This ZIP contains no supported SVG or image pages.');
  if (files.length > DESIGN_MAX_PAGES || files.length > 1 && files.some(file => ['pptx', 'zip', 'json'].includes(extension(file.name)))) throw new Error('Choose one PPTX or ZIP, or up to 12 SVG/image pages.');
  const sets: CanvaPageSet[] = [];
  const images = new Set<string>(); let imageBytes = 0, elementCount = 0;
  for (const file of files) {
    const set = await parse(file);
    for (const page of set.pages) for (const element of page.elements) {
      if (++elementCount > DESIGN_MAX_TOTAL_ELEMENTS) throw new Error('Import at most 1,000 elements in one design.');
      if (element.type === 'image' && !images.has(element.src)) {
        images.add(element.src);
        const payload = element.src.slice(element.src.indexOf(',') + 1);
        imageBytes += payload.length / 4 * 3 - (payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0);
        if (imageBytes > DESIGN_MAX_TOTAL_IMAGE_BYTES) throw new Error('The imported artwork exceeds the 30 MB embedded image limit. Import fewer pages at once.');
      }
    }
    sets.push(set);
  }
  const first = sets[0]; if (sets.length === 1) title = first.title;
  const pages = sets.flatMap(set => set.pages);
  if (!pages.length || pages.length > DESIGN_MAX_PAGES) throw new Error('Import between 1 and 12 pages.');
  const warnings = sets.flatMap(set => set.warnings);
  for (const set of sets) {
    if (Math.abs(set.width - first.width) <= 1 && Math.abs(set.height - first.height) <= 1) continue;
    if (set.pages.some(page => page.elements.some(element => element.type !== 'image'))) throw new Error('Choose SVG exports with the same page dimensions, or import each design separately.');
    const scale = Math.min(first.width / set.width, first.height / set.height);
    for (const page of set.pages) for (const element of page.elements) { element.x = element.x * scale + (first.width - set.width * scale) / 2; element.y = element.y * scale + (first.height - set.height * scale) / 2; element.width *= scale; element.height *= scale; }
    warnings.push('Image pages with different dimensions were fitted inside the first page’s canvas.');
  }
  const now = new Date().toISOString();
  const project = validateProject({ id: crypto.randomUUID(), title, createdAt: now, updatedAt: now, document: { format: DESIGN_FORMAT, version: DESIGN_VERSION, width: first.width, height: first.height, pages } });
  const elements = project.document.pages.flatMap(page => page.elements);
  return { project, summary: { pages: project.document.pages.length, editableElements: elements.filter(element => element.type !== 'image').length, imageElements: elements.filter(element => element.type === 'image').length, warnings: [...new Set(warnings)].slice(0, 50) } };
}
