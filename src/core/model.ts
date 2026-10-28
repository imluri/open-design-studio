/** Portable, data-only documents. Fabric objects, URLs and executable SVG never enter this format. */
export const DESIGN_FORMAT = 'open-design-studio' as const;
export const DESIGN_VERSION = 1 as const;
export const DESIGN_MAX_PAGES = 12;
export const DESIGN_MAX_ELEMENTS = 150;
export const DESIGN_MAX_TOTAL_ELEMENTS = 1000;
export const DESIGN_TITLE_MAX = 160;
export const DESIGN_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const DESIGN_MAX_TOTAL_IMAGE_BYTES = 30 * 1024 * 1024;
export const DESIGN_MAX_IMAGE_SIDE = 8192;
export const DESIGN_MAX_IMAGE_PIXELS = 32_000_000;
export const DESIGN_MAX_DOCUMENT_BYTES = 45 * 1024 * 1024;
export const PROJECT_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const DESIGN_FONTS = ['Arial', 'Georgia', 'Times New Roman', 'Courier New', 'Verdana', 'Trebuchet MS'] as const;
export type DesignFont = typeof DESIGN_FONTS[number];
export type DesignTextAlign = 'left' | 'center' | 'right';

export interface DesignElementBase {
  id: string; name: string; x: number; y: number; width: number; height: number;
  rotation: number; opacity: number; locked: boolean; visible: boolean;
  /** Flat, page-local logical membership. Geometry always stays in world coordinates. */
  groupId?: string;
}
export type DesignElement = DesignElementBase & (
  | { type: 'text'; text: string; fill?: string; fontSize: number; fontFamily: DesignFont; fontWeight: 400 | 700; textAlign: DesignTextAlign; letterSpacing?: number }
  | { type: 'image'; src: string }
  | { type: 'rect'; fill?: string; borderRadius?: number }
  | { type: 'ellipse'; fill?: string }
);
export interface DesignPage { id: string; name: string; background: string; elements: DesignElement[] }
export interface DesignDocument { format: typeof DESIGN_FORMAT; version: typeof DESIGN_VERSION; width: number; height: number; pages: DesignPage[] }
export interface Project { id: string; title: string; createdAt: string; updatedAt: string; document: DesignDocument }
export interface ProjectSummary { id: string; title: string; createdAt: string; updatedAt: string; width: number; height: number; pageCount: number }

export class DesignValidationError extends Error {
  constructor(message = 'This design contains unsupported or invalid values.') { super(message); this.name = 'DesignValidationError'; }
}
const fail = (message?: string): never => { throw new DesignValidationError(message); };
const ownRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !('value' in descriptors[key]))) return fail();
  return value as Record<string, unknown>;
};
const array = (value: unknown, maximum: number, minimum = 0): unknown[] => {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) return fail('A design list is outside its supported size.');
  // Reject sparse or accessor-backed arrays rather than allowing map() to skip invalid members.
  if (Reflect.ownKeys(value).length !== value.length + 1) return fail();
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor)) return fail();
  }
  return value;
};
const keys = (value: Record<string, unknown>, allowed: readonly string[]) => { if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key))) fail('The design contains an unsupported field.'); };
const text = (value: unknown, maximum: number, blank = false): string => typeof value === 'string' && value.length <= maximum && (blank || value.trim().length > 0) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) ? value : fail('A design name or text value is invalid or too long.');
const identifier = (value: unknown): string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value) ? value : fail('A design identifier is invalid.');
const number = (value: unknown, minimum: number, maximum: number): number => typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum ? value : fail('A design dimension or numeric value is outside its supported range.');
const boolean = (value: unknown): boolean => typeof value === 'boolean' ? value : fail();
const colour = (value: unknown, transparent = false): string => typeof value === 'string' && (/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(value) || (transparent && value === 'transparent')) ? value : fail('Use a hexadecimal colour value.');
const commonKeys = ['id', 'name', 'type', 'x', 'y', 'width', 'height', 'rotation', 'opacity', 'locked', 'visible', 'groupId'];

function imageInfo(value: unknown): { src: string; bytes: number } {
  const invalid = (): never => fail('Use an embedded PNG, JPEG or WebP image under 10 MB.');
  if (typeof value !== 'string' || value.length > Math.ceil(DESIGN_MAX_IMAGE_BYTES / 3) * 4 + 64) return invalid();
  const prefix = /^data:image\/(png|jpeg|webp);base64,/.exec(value);
  if (!prefix) return invalid();
  const payload = value.slice(prefix[0].length);
  if (!payload.length || payload.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) return invalid();
  const bytes = payload.length / 4 * 3 - (payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0);
  if (bytes < 12 || bytes > DESIGN_MAX_IMAGE_BYTES) return invalid();
  let binary: string;
  try { binary = atob(payload); } catch { return invalid(); }
  if (binary.length !== bytes) return invalid();
  const byte = (at: number) => binary.charCodeAt(at);
  const u16 = (at: number) => byte(at) * 256 + byte(at + 1);
  const u24le = (at: number) => byte(at) + byte(at + 1) * 256 + byte(at + 2) * 65536;
  const u32 = (at: number) => byte(at) * 16777216 + byte(at + 1) * 65536 + byte(at + 2) * 256 + byte(at + 3);
  const u32le = (at: number) => byte(at) + byte(at + 1) * 256 + byte(at + 2) * 65536 + byte(at + 3) * 16777216;
  let width = 0, height = 0;
  if (prefix[1] === 'png') {
    if (bytes < 33 || ![137, 80, 78, 71, 13, 10, 26, 10].every((value, at) => byte(at) === value) || u32(8) !== 13 || binary.slice(12, 16) !== 'IHDR') return invalid();
    width = u32(16); height = u32(20);
  } else if (prefix[1] === 'jpeg') {
    if (byte(0) !== 255 || byte(1) !== 216) return invalid();
    let offset = 2;
    while (offset < bytes) {
      if (byte(offset) !== 255) return invalid();
      while (offset < bytes && byte(offset) === 255) offset++;
      const marker = byte(offset++);
      if (!Number.isFinite(marker) || marker === 0 || marker === 218 || marker === 217) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (offset + 2 > bytes) return invalid();
      const length = u16(offset);
      if (length < 2 || offset + length > bytes) return invalid();
      if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker)) {
        if (length < 8) return invalid();
        height = u16(offset + 3); width = u16(offset + 5); break;
      }
      offset += length;
    }
  } else {
    if (bytes < 25 || binary.slice(0, 4) !== 'RIFF' || binary.slice(8, 12) !== 'WEBP' || u32le(4) + 8 !== bytes || u32le(16) + 20 > bytes) return invalid();
    const chunk = binary.slice(12, 16);
    if (chunk === 'VP8X') {
      if (bytes < 30 || u32le(16) !== 10) return invalid();
      if (byte(20) & 2) fail('Animated WebP images are not supported. Export a still image first.');
      width = u24le(24) + 1; height = u24le(27) + 1;
    } else if (chunk === 'VP8L') {
      if (u32le(16) < 5 || byte(20) !== 47) return invalid();
      width = 1 + byte(21) + ((byte(22) & 63) << 8);
      height = 1 + (byte(22) >> 6) + (byte(23) << 2) + ((byte(24) & 15) << 10);
    } else if (chunk === 'VP8 ') {
      if (bytes < 30 || u32le(16) < 10) return invalid();
      if (binary.slice(23, 26) !== '\u009d\u0001\u002a') return invalid();
      width = (byte(26) + byte(27) * 256) & 16383; height = (byte(28) + byte(29) * 256) & 16383;
    } else return invalid();
  }
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > DESIGN_MAX_IMAGE_SIDE || height > DESIGN_MAX_IMAGE_SIDE || width * height > DESIGN_MAX_IMAGE_PIXELS) fail('Images must be at most 8,192 pixels per side and 32 million pixels.');
  // This verifies source type and declared bounds. The renderer must still perform a full image decode.
  return { src: value, bytes };
}

/** No network, SVG, blob: or javascript: source can pass the image boundary. */
export function validateImageSource(src: unknown): string { return imageInfo(src).src; }

export function validateDesignDocument(value: unknown): DesignDocument {
  const input = ownRecord(value); keys(input, ['format', 'version', 'width', 'height', 'pages']);
  if (input.format !== DESIGN_FORMAT || input.version !== DESIGN_VERSION) fail('Choose a supported Open Design Studio version 1 document.');
  const width = number(input.width, 320, 4096), height = number(input.height, 320, 4096);
  if (!Number.isInteger(width) || !Number.isInteger(height)) fail('Use whole-pixel canvas dimensions from 320 to 4,096.');
  const pageList = array(input.pages, DESIGN_MAX_PAGES, 1);
  const ids = new Set<string>(), imageCache = new Map<string, number>();
  const groupPages = new Map<string, string>();
  let totalElements = 0, totalText = 0, totalImageBytes = 0;
  const uniqueId = (value: unknown) => { const id = identifier(value); if (ids.has(id)) fail('Page and element identifiers must be unique.'); ids.add(id); return id; };
  const pages = pageList.map(raw => {
    const page = ownRecord(raw); keys(page, ['id', 'name', 'background', 'elements']);
    const pageId = uniqueId(page.id);
    const elementList = array(page.elements, DESIGN_MAX_ELEMENTS);
    if ((totalElements += elementList.length) > DESIGN_MAX_TOTAL_ELEMENTS) fail('Use at most 1,000 elements per design.');
    const elements: DesignElement[] = elementList.map((rawElement): DesignElement => {
      const element = ownRecord(rawElement), type = element.type;
      if (typeof type !== 'string' || !['text', 'image', 'rect', 'ellipse'].includes(type)) fail('This element type is not supported.');
      keys(element, [...commonKeys, ...(type === 'text' ? ['text', 'fill', 'fontSize', 'fontFamily', 'fontWeight', 'textAlign', 'letterSpacing'] : type === 'image' ? ['src'] : type === 'rect' ? ['fill', 'borderRadius'] : ['fill'])]);
      const base: DesignElementBase = { id: uniqueId(element.id), name: text(element.name, 160, true), x: number(element.x, -16384, 16384), y: number(element.y, -16384, 16384), width: number(element.width, 0.1, 16384), height: number(element.height, 0.1, 16384), rotation: number(element.rotation, -360, 360), opacity: number(element.opacity, 0, 1), locked: boolean(element.locked), visible: boolean(element.visible) };
      if (element.groupId !== undefined) {
        const groupId = identifier(element.groupId), existingPage = groupPages.get(groupId);
        if (existingPage !== undefined && existingPage !== pageId) fail('Each group must belong to one page.');
        groupPages.set(groupId, pageId); base.groupId = groupId;
      }
      if (type === 'image') {
        const src = typeof element.src === 'string' ? element.src : fail('An image source is invalid.');
        let imageBytes = imageCache.get(src);
        if (imageBytes === undefined) {
          const image = imageInfo(src); imageBytes = image.bytes; imageCache.set(image.src, image.bytes);
          totalImageBytes += image.bytes;
          if (totalImageBytes > DESIGN_MAX_TOTAL_IMAGE_BYTES) fail('The design supports at most 30 MB of distinct embedded image sources.');
        }
        return { ...base, type: 'image', src };
      }
      const fill = element.fill === undefined ? {} : { fill: colour(element.fill, true) };
      if (type === 'text') {
        const content = text(element.text, 5000, true); totalText += content.length;
        if (totalText > 50000) fail('The design contains too much text.');
        if (!DESIGN_FONTS.includes(element.fontFamily as DesignFont) || (element.fontWeight !== 400 && element.fontWeight !== 700) || typeof element.textAlign !== 'string' || !['left', 'center', 'right'].includes(element.textAlign)) fail('Choose a supported font, weight and text alignment.');
        return { ...base, ...fill, type: 'text', text: content, fontSize: number(element.fontSize, 6, 512), fontFamily: element.fontFamily as DesignFont, fontWeight: element.fontWeight as 400 | 700, textAlign: element.textAlign as DesignTextAlign, ...(element.letterSpacing === undefined ? {} : { letterSpacing: number(element.letterSpacing, -10, 100) }) };
      }
      if (type === 'rect') return { ...base, ...fill, type: 'rect', ...(element.borderRadius === undefined ? {} : { borderRadius: number(element.borderRadius, 0, 2048) }) };
      return { ...base, ...fill, type: 'ellipse' };
    });
    return { id: pageId, name: text(page.name, 160), background: colour(page.background), elements };
  });
  // Check after every record has been visited, including IDs on later pages.
  if ([...groupPages.keys()].some(groupId => ids.has(groupId))) fail('Group identifiers must not match a page or element identifier.');
  const document: DesignDocument = { format: DESIGN_FORMAT, version: DESIGN_VERSION, width, height, pages };
  if (new TextEncoder().encode(JSON.stringify(document)).byteLength > DESIGN_MAX_DOCUMENT_BYTES) fail('The design JSON must be under 45 MB.');
  return document;
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value))) return fail('Project dates must use UTC ISO timestamps.');
  if (new Date(value).toISOString() !== value) return fail('A project date is invalid.');
  return value;
}

export function validateProject(value: unknown): Project {
  const project = ownRecord(value); keys(project, ['id', 'title', 'createdAt', 'updatedAt', 'document']);
  const createdAt = timestamp(project.createdAt), updatedAt = timestamp(project.updatedAt);
  if (updatedAt < createdAt) fail('The project update date cannot precede its creation date.');
  return { id: identifier(project.id), title: text(project.title, DESIGN_TITLE_MAX).trim(), createdAt, updatedAt, document: validateDesignDocument(project.document) };
}
