import { Unzip, UnzipInflate, type UnzipFile } from 'fflate';
import { importImage, pageObjects } from '../canvas';
import { DESIGN_FONTS, DESIGN_MAX_ELEMENTS, DESIGN_MAX_PAGES, validateDesignDocument } from '../model';
import type { DesignElement, DesignElementBase, DesignFont, DesignPage } from '../model';
import type { CanvaPageSet } from './types';

const MIB = 1024 * 1024;
const MAX_FILE = 50 * MIB, MAX_EXPANDED = 64 * MIB, MAX_ENTRY = 12 * MIB, MAX_XML = 4 * MIB;
const MAX_ENTRIES = 1000, MAX_DEPTH = 24, MAX_WARNINGS = 160;
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const EMU_PER_POINT = 12700, EMU_PER_PIXEL = 9525;
type Matrix = [number, number, number, number, number, number];
type Relationship = { type: string; target: string | null; external: boolean };
type Relationships = Map<string, Relationship>;
type Raster = Awaited<ReturnType<typeof importImage>>;
type Theme = { colours: Map<string, string>; colourMap: Map<string, string>; major: string; minor: string };
type Context = { matrix: Matrix; groupId?: string; visible: boolean; opacity: number; slide: number; theme: Theme; layout: Document | null; master: Document | null; relationships: Relationships; part: string };
type Frame = { matrix: Matrix; width: number; height: number };
const uid = () => crypto.randomUUID();
const rounded = (value: number) => Math.round(value * 100) / 100;
const children = (node: ParentNode | null | undefined, name?: string): Element[] => node ? Array.from(node.children).filter(element => !name || element.localName === name) : [];
const child = (node: ParentNode | null | undefined, name: string): Element | null => children(node, name)[0] ?? null;
const descendant = (node: Document | Element | null | undefined, name: string): Element | null => node?.getElementsByTagNameNS('*', name)[0] ?? null;
const descendants = (node: Document | Element | null | undefined, name: string): Element[] => node ? Array.from(node.getElementsByTagNameNS('*', name)) : [];
const clean = (value: string, maximum = 160) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, maximum);
const attrNumber = (node: Element | null | undefined, name: string, fallback = 0): number => {
  const raw = node?.getAttribute(name);
  if (raw === null || raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || Math.abs(value) > 1e14) throw new Error('The presentation contains an invalid numeric transform.');
  return value;
};
const flag = (node: Element | null | undefined, name: string) => ['1', 'true'].includes(node?.getAttribute(name) ?? '');
const relationshipId = (node: Element | null | undefined, name = 'id') => node?.getAttributeNS(REL_NS, name) ?? node?.getAttribute(`r:${name}`) ?? '';
const multiply = (a: Matrix, b: Matrix): Matrix => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
const translation = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y];
const scaling = (x: number, y: number): Matrix => [x, 0, 0, y, 0, 0];
const rotation = (degrees: number): Matrix => { const angle = degrees * Math.PI / 180; return [Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 0, 0]; };

function xmlText(data: Uint8Array): string {
  let source: string;
  try {
    const encoding = data[0] === 255 && data[1] === 254 ? 'utf-16le' : data[0] === 254 && data[1] === 255 ? 'utf-16be' : 'utf-8';
    source = new TextDecoder(encoding, { fatal: true }).decode(data);
  } catch { throw new Error('A presentation XML part uses invalid text encoding.'); }
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source)) throw new Error('Presentations containing XML document types or entity declarations cannot be imported.');
  return source;
}

type ZipMetadata = { size: number; compressed: number; crc: number; method: number };
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});
const zipName = (bytes: Uint8Array, utf8: boolean) => {
  if (utf8) { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('The ZIP archive contains an invalid filename.'); } }
  let value = ''; for (const byte of bytes) value += String.fromCharCode(byte); return value;
};
const safeZipName = (name: string) => Boolean(name) && name.length <= 512 && !/[\u0000-\u001f\u007f\\]/.test(name) && !name.startsWith('/') && !/^[a-z]:/i.test(name) && !name.split('/').some(segment => segment === '..' || segment === '.');

/** Ordinary single-disk ZIP only; inspect all trusted bounds before starting inflation. */
function zipMetadata(archive: Uint8Array): Map<string, ZipMetadata> {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength), result = new Map<string, ZipMetadata>(), folded = new Set<string>();
  let end = -1;
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 65557); offset--) {
    if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === archive.length) { end = offset; break; }
  }
  if (end < 0) throw new Error('The ZIP archive is incomplete or uses an unsupported ZIP64 format.');
  const count = view.getUint16(end + 10, true), directorySize = view.getUint32(end + 12, true), directoryOffset = view.getUint32(end + 16, true);
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || view.getUint16(end + 8, true) !== count || count === 65535 || directorySize === 0xffffffff || directoryOffset === 0xffffffff) throw new Error('Split and ZIP64 archives are not supported.');
  if (count > MAX_ENTRIES || directoryOffset + directorySize !== end) throw new Error('The ZIP directory is invalid or contains more than 1,000 entries.');
  let offset = directoryOffset, expanded = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) throw new Error('The ZIP directory is damaged.');
    const flags = view.getUint16(offset + 8, true), method = view.getUint16(offset + 10, true), crc = view.getUint32(offset + 16, true), compressed = view.getUint32(offset + 20, true), size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true), extraLength = view.getUint16(offset + 30, true), commentLength = view.getUint16(offset + 32, true), disk = view.getUint16(offset + 34, true), localOffset = view.getUint32(offset + 42, true);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > end || disk || [compressed, size, localOffset].includes(0xffffffff)) throw new Error('The ZIP entry metadata is invalid or uses ZIP64.');
    if (flags & 1 || flags & 64) throw new Error('Encrypted ZIP archives are not supported.');
    if (method !== 0 && method !== 8) throw new Error('This ZIP archive uses an unsupported compression method.');
    const name = zipName(archive.subarray(offset + 46, offset + 46 + nameLength), Boolean(flags & 2048));
    if (!safeZipName(name) || folded.has(name.toLowerCase())) throw new Error('The ZIP contains unsafe, duplicate or case-ambiguous paths.');
    folded.add(name.toLowerCase());
    const limit = /\.(?:xml|rels)$/i.test(name) ? MAX_XML : MAX_ENTRY;
    if (size > limit) throw new Error(/\.(?:xml|rels)$/i.test(name) ? 'Each XML entry must be smaller than 4 MB.' : 'Each ZIP entry must be smaller than 12 MB.');
    expanded += size; if (expanded > MAX_EXPANDED) throw new Error('The expanded ZIP archive must be smaller than 64 MB.');
    if (localOffset + 30 > directoryOffset || view.getUint32(localOffset, true) !== 0x04034b50 || view.getUint16(localOffset + 6, true) !== flags || view.getUint16(localOffset + 8, true) !== method) throw new Error('A ZIP entry has inconsistent local metadata.');
    const localNameLength = view.getUint16(localOffset + 26, true), localExtraLength = view.getUint16(localOffset + 28, true), dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressed > directoryOffset || zipName(archive.subarray(localOffset + 30, localOffset + 30 + localNameLength), Boolean(flags & 2048)) !== name) throw new Error('A ZIP entry points outside the archive or has a conflicting filename.');
    if (!(flags & 8) && (view.getUint32(localOffset + 14, true) !== crc || view.getUint32(localOffset + 18, true) !== compressed || view.getUint32(localOffset + 22, true) !== size)) throw new Error('A ZIP entry has conflicting sizes or checksum metadata.');
    result.set(name, { size, compressed, crc, method }); offset = next;
  }
  if (offset !== end) throw new Error('The ZIP directory contains unsupported trailing records.');
  return result;
}

/** Stream even ignored entries through bounded counters; never allocate a declared ZIP size. */
export async function unpackCanvaZip(file: File, keepEntry: (name: string) => boolean = name => /\.(?:xml|rels)$/i.test(name) || /^ppt\/media\//.test(name)): Promise<Map<string, Uint8Array>> {
  if (!file.size || file.size > MAX_FILE) throw new Error('Choose a ZIP archive smaller than 50 MB.');
  const archive = new Uint8Array(await file.arrayBuffer());
  if (archive[0] !== 80 || archive[1] !== 75 || archive[2] !== 3 || archive[3] !== 4) throw new Error('This file is not a supported, unencrypted ZIP archive.');
  const metadata = zipMetadata(archive);
  const files = new Map<string, Uint8Array>(), names = new Set<string>(), active = new Set<UnzipFile>();
  let entries = 0, expanded = 0, declared = 0, pending = 0, failure: Error | null = null;
  const stop = (error: unknown) => {
    failure ??= error instanceof Error ? error : new Error('The ZIP archive could not be opened.');
    for (const entry of active) { try { entry.terminate(); } catch { /* Synchronous streams have no worker to stop. */ } }
  };
  const unzip = new Unzip(entry => {
    if (failure) return;
    try {
      const name = entry.name;
      if (++entries > MAX_ENTRIES) throw new Error('ZIP archives may contain at most 1,000 entries.');
      if (!safeZipName(name) || names.has(name.toLowerCase())) throw new Error('The ZIP archive contains unsafe, duplicate or case-ambiguous paths.');
      names.add(name.toLowerCase());
      const expected = metadata.get(name);
      if (!expected || entry.compression !== expected.method || (entry.size !== undefined && entry.size !== expected.compressed)) throw new Error('A ZIP entry disagrees with its directory metadata.');
      const xml = /\.(?:xml|rels)$/i.test(name), limit = xml ? MAX_XML : MAX_ENTRY;
      if (entry.compression !== 0 && entry.compression !== 8) throw new Error('This ZIP archive uses an unsupported compression method.');
      if (entry.originalSize !== undefined) {
        if (!Number.isSafeInteger(entry.originalSize) || entry.originalSize !== expected.size || entry.originalSize < 0 || entry.originalSize > limit) throw new Error('A ZIP entry has an invalid or excessive declared size.');
        declared += entry.originalSize;
        if (declared > MAX_EXPANDED) throw new Error('The expanded ZIP archive must be smaller than 64 MB.');
      }
      const keep = !name.endsWith('/') && keepEntry(name);
      const chunks: Uint8Array[] = []; let bytes = 0, checksum = 0xffffffff;
      pending++; active.add(entry);
      entry.ondata = (error, chunk, final) => {
        if (failure) return;
        if (error) { stop(new Error('The ZIP archive contains a damaged or encrypted entry.')); return; }
        bytes += chunk.byteLength; expanded += chunk.byteLength;
        if (bytes > limit || bytes > expected.size || expanded > MAX_EXPANDED) { stop(new Error(bytes > limit || bytes > expected.size ? 'A ZIP entry exceeds its declared size or size limit.' : 'The expanded ZIP archive must be smaller than 64 MB.')); return; }
        for (const byte of chunk) checksum = CRC_TABLE[(checksum ^ byte) & 255] ^ checksum >>> 8;
        if (keep && chunk.length) chunks.push(chunk.slice());
        if (final) {
          pending--; active.delete(entry);
          if (bytes !== expected.size || (checksum ^ 0xffffffff) >>> 0 !== expected.crc) { stop(new Error('A ZIP entry failed its size or checksum check.')); return; }
          if (!keep) return;
          const data = new Uint8Array(bytes); let offset = 0;
          for (const part of chunks) { data.set(part, offset); offset += part.length; }
          if (xml) { try { xmlText(data); } catch (caught) { stop(caught); return; } }
          files.set(name, data);
        }
      };
      entry.start();
    } catch (error) { stop(error); }
  });
  unzip.register(UnzipInflate);
  try {
    // A small compressed chunk limits a DEFLATE bomb's output before the next budget check.
    for (let offset = 0; offset < archive.length; offset += 1024) {
      if (failure) throw failure;
      unzip.push(archive.subarray(offset, offset + 1024), offset + 1024 >= archive.length);
      if (offset % (128 * 1024) === 0) await new Promise<void>(resolve => window.setTimeout(resolve, 0));
    }
  } catch (error) { stop(error); }
  if (failure) throw failure;
  if (pending || entries !== metadata.size) throw new Error('The ZIP archive ended before all entries were complete.');
  return files;
}

function resolvePart(source: string, target: string): string | null {
  let decoded: string;
  try { decoded = decodeURIComponent(target); } catch { return null; }
  if (!decoded || decoded.startsWith('//') || /[\u0000-\u001f\u007f\\?#]/.test(decoded) || /^[a-z][a-z\d+.-]*:/i.test(decoded)) return null;
  const parts = decoded.startsWith('/') ? [] : source.split('/').slice(0, -1);
  for (const segment of decoded.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') { if (!parts.length) return null; parts.pop(); }
    else parts.push(segment);
  }
  return parts.join('/');
}
const relsPath = (part: string) => { const pieces = part.split('/'), name = pieces.pop(); return [...pieces, '_rels', `${name}.rels`].join('/'); };

function frameTransform(xfrm: Element | null, parent: Matrix): Frame | null {
  const off = child(xfrm, 'off'), ext = child(xfrm, 'ext');
  if (!xfrm || !off || !ext) return null;
  const x = attrNumber(off, 'x'), y = attrNumber(off, 'y'), width = attrNumber(ext, 'cx'), height = attrNumber(ext, 'cy');
  if (width <= 0 || height <= 0) return null;
  let matrix = multiply(translation(x + width / 2, y + height / 2), rotation(attrNumber(xfrm, 'rot') / 60000));
  matrix = multiply(matrix, scaling(flag(xfrm, 'flipH') ? -1 : 1, flag(xfrm, 'flipV') ? -1 : 1));
  matrix = multiply(matrix, translation(-width / 2, -height / 2));
  return { matrix: multiply(parent, matrix), width, height };
}

function groupTransform(node: Element, parent: Matrix): Matrix | null {
  const xfrm = child(child(node, 'grpSpPr'), 'xfrm');
  const off = child(xfrm, 'off'), ext = child(xfrm, 'ext'), chOff = child(xfrm, 'chOff'), chExt = child(xfrm, 'chExt');
  if (!xfrm || !off || !ext || !chOff || !chExt) return null;
  const width = attrNumber(ext, 'cx'), height = attrNumber(ext, 'cy'), childWidth = attrNumber(chExt, 'cx'), childHeight = attrNumber(chExt, 'cy');
  if (Math.min(width, height, childWidth, childHeight) <= 0) return null;
  let matrix = multiply(translation(attrNumber(off, 'x') + width / 2, attrNumber(off, 'y') + height / 2), rotation(attrNumber(xfrm, 'rot') / 60000));
  matrix = multiply(matrix, scaling((flag(xfrm, 'flipH') ? -1 : 1) * width / childWidth, (flag(xfrm, 'flipV') ? -1 : 1) * height / childHeight));
  return multiply(parent, multiply(matrix, translation(-attrNumber(chOff, 'x') - childWidth / 2, -attrNumber(chOff, 'y') - childHeight / 2)));
}

function geometry(frame: Frame, name: string, context: Context, inset?: { x: number; y: number; width: number; height: number }): { base: DesignElementBase; scaleX: number; scaleY: number } {
  const [a, b, c, d, e, f] = frame.matrix, scaleX = Math.hypot(a, b), determinant = a * d - b * c, scaleY = determinant / scaleX;
  if (![...frame.matrix, scaleX, scaleY].every(Number.isFinite) || scaleX <= 0 || scaleY <= 0 || Math.abs(a * c + b * d) > scaleX * Math.hypot(c, d) * 0.000001) throw new Error('skewed or reflected geometry');
  const box = inset ?? { x: 0, y: 0, width: frame.width, height: frame.height };
  const x = rounded(a * box.x + c * box.y + e), y = rounded(b * box.x + d * box.y + f), width = rounded(box.width * scaleX), height = rounded(box.height * scaleY);
  if (Math.abs(x) > 16384 || Math.abs(y) > 16384 || width < 0.1 || height < 0.1 || width > 16384 || height > 16384) throw new Error('geometry outside the supported editor bounds');
  return { base: { id: uid(), name: clean(name) || 'Imported element', x, y, width, height, rotation: rounded(((Math.atan2(b, a) * 180 / Math.PI + 180) % 360 + 360) % 360 - 180), opacity: context.opacity, visible: context.visible, locked: false, ...(context.groupId ? { groupId: context.groupId } : {}) }, scaleX, scaleY };
}

function defaultTheme(): Theme {
  return { colours: new Map([['dk1', '#000000'], ['lt1', '#ffffff'], ['dk2', '#1f497d'], ['lt2', '#eeece1'], ['accent1', '#4f81bd'], ['accent2', '#c0504d'], ['accent3', '#9bbb59'], ['accent4', '#8064a2'], ['accent5', '#4bacc6'], ['accent6', '#f79646'], ['hlink', '#0000ff'], ['folHlink', '#800080']]), colourMap: new Map([['bg1', 'lt1'], ['tx1', 'dk1'], ['bg2', 'lt2'], ['tx2', 'dk2']]), major: 'Arial', minor: 'Arial' };
}

function colourFrom(node: Element | null, theme: Theme, warn: (message: string) => void): string | null {
  if (!node) return null;
  const colour = ['srgbClr', 'sysClr', 'schemeClr', 'scrgbClr', 'prstClr'].includes(node.localName) ? node : children(node).find(item => ['srgbClr', 'sysClr', 'schemeClr', 'scrgbClr', 'prstClr'].includes(item.localName));
  if (!colour) return null;
  let hex: string | undefined;
  if (colour.localName === 'srgbClr') hex = colour.getAttribute('val') ?? undefined;
  else if (colour.localName === 'sysClr') hex = colour.getAttribute('lastClr') ?? undefined;
  else if (colour.localName === 'schemeClr') { const key = colour.getAttribute('val') ?? ''; hex = theme.colours.get(theme.colourMap.get(key) ?? key)?.slice(1); }
  else if (colour.localName === 'scrgbClr') hex = ['r', 'g', 'b'].map(key => {
    const linear = Math.max(0, Math.min(1, attrNumber(colour, key) / 100000));
    const encoded = linear <= 0.0031308 ? linear * 12.92 : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
    return Math.round(encoded * 255).toString(16).padStart(2, '0');
  }).join('');
  else hex = ({ black: '000000', white: 'ffffff', red: 'ff0000', green: '008000', blue: '0000ff', yellow: 'ffff00', gray: '808080', grey: '808080', orange: 'ffa500', purple: '800080' } as Record<string, string>)[colour.getAttribute('val') ?? ''];
  if (!hex || !/^[0-9a-f]{6}$/i.test(hex)) { warn('An unsupported colour could not be retained.'); return null; }
  let rgb = [0, 2, 4].map(offset => parseInt(hex!.slice(offset, offset + 2), 16) / 255), alpha = 1;
  for (const transform of children(colour)) {
    const value = attrNumber(transform, 'val') / 100000;
    if (transform.localName === 'alpha') alpha = value;
    else if (transform.localName === 'alphaMod') alpha *= value;
    else if (transform.localName === 'alphaOff') alpha += value;
    else if (transform.localName === 'tint') rgb = rgb.map(channel => channel + (1 - channel) * value);
    else if (transform.localName === 'shade') rgb = rgb.map(channel => channel * value);
    else if (transform.localName === 'lumMod' || transform.localName === 'lumOff') {
      const max = Math.max(...rgb), min = Math.min(...rgb), old = (max + min) / 2;
      const light = Math.max(0, Math.min(1, transform.localName === 'lumMod' ? old * value : old + value));
      const chroma = max - min, saturation = chroma === 0 ? 0 : chroma / (1 - Math.abs(2 * old - 1));
      let hue = 0;
      if (chroma) hue = (max === rgb[0] ? (rgb[1] - rgb[2]) / chroma % 6 : max === rgb[1] ? (rgb[2] - rgb[0]) / chroma + 2 : (rgb[0] - rgb[1]) / chroma + 4) * 60;
      hue = (hue + 360) % 360;
      const nextChroma = (1 - Math.abs(2 * light - 1)) * saturation, x = nextChroma * (1 - Math.abs(hue / 60 % 2 - 1)), m = light - nextChroma / 2;
      const channels = hue < 60 ? [nextChroma, x, 0] : hue < 120 ? [x, nextChroma, 0] : hue < 180 ? [0, nextChroma, x] : hue < 240 ? [0, x, nextChroma] : hue < 300 ? [x, 0, nextChroma] : [nextChroma, 0, x];
      rgb = channels.map(channel => channel + m);
    } else warn(`Colour transform ${clean(transform.localName)} was simplified.`);
  }
  const value = '#' + rgb.map(channel => Math.round(Math.max(0, Math.min(1, channel)) * 255).toString(16).padStart(2, '0')).join('');
  return alpha >= 1 ? value : value + Math.round(Math.max(0, alpha) * 255).toString(16).padStart(2, '0');
}

async function croppedRaster(image: Raster, crop: Element): Promise<Raster> {
  const [left, top, right, bottom] = ['l', 't', 'r', 'b'].map(key => attrNumber(crop, key) / 100000);
  if ([left, top, right, bottom].some(value => value < 0 || value >= 1) || left + right >= 1 || top + bottom >= 1) throw new Error('The image uses an unsupported crop or out-of-image padding.');
  if (![left, top, right, bottom].some(Boolean)) return image;
  const source = new Image();
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => { source.onload = null; source.onerror = null; source.removeAttribute('src'); reject(new Error('The cropped image took too long to decode.')); }, 15000);
    source.onload = () => { window.clearTimeout(timer); resolve(); };
    source.onerror = () => { window.clearTimeout(timer); reject(new Error('The cropped image could not be decoded.')); };
    source.src = image.src;
  });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.width * (1 - left - right)));
  canvas.height = Math.max(1, Math.round(image.height * (1 - top - bottom)));
  try {
    const context = canvas.getContext('2d'); if (!context) throw new Error('This browser could not preserve the image crop.');
    context.drawImage(source, image.width * left, image.height * top, image.width * (1 - left - right), image.height * (1 - top - bottom), 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('The cropped image could not be saved.')), 'image/png'));
    return await importImage(new File([blob], `${image.name}-cropped.png`, { type: 'image/png' }));
  } finally { source.onload = null; source.onerror = null; source.removeAttribute('src'); canvas.width = 0; canvas.height = 0; }
}

/** Local OOXML subset importer. Unhandled artwork is reported rather than fetched or guessed. */
export async function importCanvaPptx(file: File): Promise<CanvaPageSet> {
  const files = await unpackCanvaZip(file), documents = new Map<string, Document>(), relationshipsCache = new Map<string, Relationships>();
  const warnings: string[] = [], warningSet = new Set<string>(); let extraWarnings = 0;
  const warn = (message: string) => { const safe = clean(message, 360); if (warningSet.has(safe)) return; warningSet.add(safe); if (warnings.length < MAX_WARNINGS) warnings.push(safe); else extraWarnings++; };
  const xml = (part: string, required = false): Document | null => {
    if (documents.has(part)) return documents.get(part)!;
    const bytes = files.get(part);
    if (!bytes) { if (required) throw new Error(`The presentation is missing ${clean(part, 180)}.`); return null; }
    if (bytes.length > MAX_XML) throw new Error('Each presentation XML part must be smaller than 4 MB.');
    const document = new DOMParser().parseFromString(xmlText(bytes), 'application/xml');
    if (document.getElementsByTagNameNS('*', 'parsererror').length || document.documentElement.localName === 'parsererror') throw new Error(`The presentation contains invalid XML in ${clean(part, 180)}.`);
    documents.set(part, document); return document;
  };
  const relationships = (part: string): Relationships => {
    const cached = relationshipsCache.get(part); if (cached) return cached;
    const result: Relationships = new Map(), document = xml(relsPath(part));
    for (const relation of descendants(document, 'Relationship')) {
      const id = relation.getAttribute('Id') ?? '', target = relation.getAttribute('Target') ?? '', external = (relation.getAttribute('TargetMode') ?? '').toLowerCase() === 'external';
      if (!id || result.has(id)) throw new Error('The presentation contains invalid or duplicate relationship identifiers.');
      const resolved = external ? null : resolvePart(part, target);
      result.set(id, { type: relation.getAttribute('Type') ?? '', target: resolved, external });
      if (external) warn('External images, links and resources are not fetched. Hyperlinks are not retained.');
      else if (!resolved) warn('An unsafe or unsupported package relationship was ignored.');
    }
    relationshipsCache.set(part, result); return result;
  };
  const related = (part: string, type: string): string | null => [...relationships(part).values()].find(relation => !relation.external && relation.target && relation.type.endsWith(`/${type}`))?.target ?? null;
  const presentation = xml('ppt/presentation.xml', true)!;
  if (presentation.documentElement.localName !== 'presentation') throw new Error('This archive does not contain a supported PowerPoint presentation.');
  const size = child(presentation.documentElement, 'sldSz'), emuWidth = attrNumber(size, 'cx'), emuHeight = attrNumber(size, 'cy');
  if (emuWidth <= 0 || emuHeight <= 0) throw new Error('The presentation has invalid slide dimensions.');
  let emuScale = 1 / EMU_PER_PIXEL;
  emuScale = Math.min(emuScale, 4096 / Math.max(emuWidth, emuHeight));
  emuScale = Math.max(emuScale, 320 / Math.min(emuWidth, emuHeight));
  const width = Math.round(emuWidth * emuScale), height = Math.round(emuHeight * emuScale);
  if (Math.max(width, height) > 4096 || Math.min(width, height) < 320) throw new Error('The presentation aspect ratio cannot fit the editor’s 320–4,096 pixel canvas limits.');
  const slideIds = children(child(presentation.documentElement, 'sldIdLst'), 'sldId');
  if (!slideIds.length || slideIds.length > DESIGN_MAX_PAGES) throw new Error('Import a presentation with 1 to 12 slides.');
  const presentationRels = relationships('ppt/presentation.xml'), seenSlides = new Set<string>();
  const rasterCache = new Map<string, Promise<Raster>>(), cropCache = new Map<string, Promise<Raster>>();
  const embeddedSources = new Set<string>(); let embeddedBytes = 0, totalElements = 0;
  const raster = (part: string): Promise<Raster> => {
    let pending = rasterCache.get(part);
    if (!pending) {
      const data = files.get(part);
      pending = data ? importImage(new File([new Uint8Array(data).buffer], part.split('/').pop() ?? 'image', { type: '' })) : Promise.reject(new Error('The embedded image file is missing.'));
      rasterCache.set(part, pending);
    }
    return pending;
  };

  const themeFor = (masterPart: string | null): Theme => {
    const theme = defaultTheme(), themePart = masterPart ? related(masterPart, 'theme') : null;
    const document = themePart ? xml(themePart) : null;
    if (!document) warn('A presentation theme could not be resolved. Default Office colours and Arial are used for inherited styles.');
    for (const entry of children(descendant(document, 'clrScheme'))) {
      const colour = colourFrom(entry, theme, warn); if (colour) theme.colours.set(entry.localName, colour.slice(0, 7));
    }
    theme.major = child(child(descendant(document, 'fontScheme'), 'majorFont'), 'latin')?.getAttribute('typeface') || 'Arial';
    theme.minor = child(child(descendant(document, 'fontScheme'), 'minorFont'), 'latin')?.getAttribute('typeface') || 'Arial';
    const map = masterPart ? descendant(xml(masterPart), 'clrMap') : null;
    if (map) for (const attribute of Array.from(map.attributes)) theme.colourMap.set(attribute.localName, attribute.value);
    return theme;
  };

  const placeholder = (node: Element) => descendant(child(node, node.localName === 'pic' ? 'nvPicPr' : 'nvSpPr'), 'ph');
  const placeholderShapes = (node: Element, context: Context): Element[] => {
    const ph = placeholder(node); if (!ph) return [];
    const matches: Element[] = [];
    const index = ph.getAttribute('idx'), type = ph.getAttribute('type') ?? 'obj';
    for (const document of [context.layout, context.master]) {
      const match = descendants(document, 'sp').find(shape => {
        const candidate = placeholder(shape); return candidate && (index !== null ? (candidate.getAttribute('idx') ?? '0') === index : (candidate.getAttribute('type') ?? 'obj') === type);
      });
      if (match) matches.push(match);
    }
    return matches;
  };

  // The recursive shape reader is below; its output always remains the native flat model.
  const pages: DesignPage[] = [];
  for (let slideIndex = 0; slideIndex < slideIds.length; slideIndex++) {
    const relation = presentationRels.get(relationshipId(slideIds[slideIndex]));
    if (!relation?.target || relation.external || !relation.type.endsWith('/slide') || seenSlides.has(relation.target)) throw new Error('The presentation has an invalid or duplicate slide relationship.');
    const part = relation.target; seenSlides.add(part);
    const slide = xml(part, true)!, layoutPart = related(part, 'slideLayout'), layout = layoutPart ? xml(layoutPart) : null;
    const masterPart = layoutPart ? related(layoutPart, 'slideMaster') : null, master = masterPart ? xml(masterPart) : null;
    const theme = themeFor(masterPart), elements: DesignElement[] = []; let skipped = 0;
    for (const source of [layout, slide]) {
      const override = child(child(source?.documentElement, 'clrMapOvr'), 'overrideClrMapping');
      if (override) for (const attribute of Array.from(override.attributes)) theme.colourMap.set(attribute.localName, attribute.value);
    }
    const slideWarn = (message: string) => warn(`Slide ${slideIndex + 1}: ${message}`);
    const context: Context = { matrix: [emuScale, 0, 0, emuScale, 0, 0], visible: true, opacity: 1, slide: slideIndex, theme, layout, master, relationships: relationships(part), part };
    const add = (element: DesignElement) => {
      if (elements.length >= DESIGN_MAX_ELEMENTS) throw new Error(`Slide ${slideIndex + 1} contains more than 150 editable elements.`);
      if (totalElements >= 1000) throw new Error('A presentation may contain at most 1,000 editable elements.');
      if (element.type === 'image' && !embeddedSources.has(element.src)) {
        const payload = element.src.slice(element.src.indexOf(',') + 1);
        embeddedBytes += payload.length / 4 * 3 - (payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0);
        if (embeddedBytes > 30 * MIB) throw new Error('The imported presentation exceeds 30 MB of distinct embedded images. Import fewer slides or smaller images.');
        embeddedSources.add(element.src);
      }
      elements.push(element); totalElements++;
    };
    const skip = (message: string) => { skipped++; slideWarn(message); };

    const tryGeometry = (frame: Frame, name: string, current: Context, inset?: { x: number; y: number; width: number; height: number }) => {
      try { return geometry(frame, name, current, inset); }
      catch (error) { skip(`${clean(name) || 'Element'} was omitted because it has ${error instanceof Error ? error.message : 'an unsupported transform'}.`); return null; }
    };
    const effects = (properties: Element | null, name: string) => {
      if (child(properties, 'effectLst')?.children.length || child(properties, 'effectDag')?.children.length || child(properties, 'scene3d') || child(properties, 'sp3d')) slideWarn(`${clean(name)}: shadows, 3D and other visual effects are not retained.`);
      const line = child(properties, 'ln');
      if (line && !child(line, 'noFill') && (child(line, 'solidFill') || attrNumber(line, 'w') > 0)) slideWarn(`${clean(name)}: the shape outline is not retained.`);
    };
    const textElement = async (shape: Element, frame: Frame, current: Context, name: string, fallbacks: Element[]): Promise<DesignElement | null> => {
      const body = child(shape, 'txBody'); if (!body) return null;
      const paragraphs = children(body, 'p');
      const content = paragraphs.map(paragraph => {
        const bullet = child(child(paragraph, 'pPr'), 'buChar')?.getAttribute('char') ?? '';
        if (bullet || child(child(paragraph, 'pPr'), 'buAutoNum')) slideWarn(`${clean(name)}: bullets and numbering were simplified to plain text.`);
        return (bullet ? `${bullet} ` : '') + children(paragraph).map(run => run.localName === 'br' ? '\n' : run.localName === 'r' || run.localName === 'fld' ? child(run, 't')?.textContent ?? '' : '').join('');
      }).join('\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
      if (!content.trim()) return null;
      if (content.length > 5000) throw new Error(`Slide ${slideIndex + 1} has a text element longer than 5,000 characters.`);
      const bodyPr = child(body, 'bodyPr'), bodyProperties = [bodyPr, ...fallbacks.map(fallback => child(child(fallback, 'txBody'), 'bodyPr'))].filter((value): value is Element => Boolean(value));
      const bodyAttribute = (attribute: string) => bodyProperties.map(properties => properties.getAttribute(attribute)).find(value => value !== null) ?? null;
      const bodyNumber = (attribute: string, value: number) => attrNumber(bodyProperties.find(properties => properties.hasAttribute(attribute)), attribute, value);
      if ((bodyAttribute('vert') && bodyAttribute('vert') !== 'horz') || bodyNumber('rot', 0) !== 0 || bodyProperties.some(properties => child(properties, 'prstTxWarp'))) { skip(`${clean(name)}: vertical, independently rotated or warped text is not supported.`); return null; }
      const firstParagraph = paragraphs.find(paragraph => children(paragraph).some(run => ['r', 'fld'].includes(run.localName) && child(run, 't')?.textContent)) ?? paragraphs[0], pPr = child(firstParagraph, 'pPr');
      const level = Math.max(0, Math.min(8, attrNumber(pPr, 'lvl')));
      const placeholderType = placeholder(shape)?.getAttribute('type') ?? '';
      const masterStyle = child(descendant(current.master, 'txStyles'), ['title', 'ctrTitle'].includes(placeholderType) ? 'titleStyle' : placeholderType === 'body' ? 'bodyStyle' : 'otherStyle');
      const firstRun = children(firstParagraph).find(run => run.localName === 'r' || run.localName === 'fld');
      const inheritedParagraphStyles = fallbacks.flatMap(fallback => {
        const inheritedBody = child(fallback, 'txBody');
        return [child(child(inheritedBody, 'p'), 'pPr'), child(child(inheritedBody, 'lstStyle'), `lvl${level + 1}pPr`)];
      }).filter((value): value is Element => Boolean(value));
      const paragraphStyles = [pPr, child(child(body, 'lstStyle'), `lvl${level + 1}pPr`), ...inheritedParagraphStyles, child(masterStyle, `lvl${level + 1}pPr`)].filter((value): value is Element => Boolean(value));
      const styles = [child(firstRun, 'rPr'), ...paragraphStyles.map(properties => child(properties, 'defRPr')), child(firstParagraph, 'endParaRPr')].filter((value): value is Element => Boolean(value));
      const styleAttribute = (attribute: string) => styles.map(style => style.getAttribute(attribute)).find(value => value !== null) ?? null;
      const styleChild = (name: string) => styles.map(style => child(style, name)).find(Boolean) ?? null;
      const runStyles = descendants(body, 'rPr');
      if (new Set(runStyles.map(style => [style.getAttribute('sz'), style.getAttribute('b'), style.getAttribute('i'), child(style, 'latin')?.getAttribute('typeface'), child(child(style, 'solidFill'), 'srgbClr')?.getAttribute('val')].join('|'))).size > 1) slideWarn(`${clean(name)}: mixed text styles were simplified to the first text style.`);
      if (runStyles.some(style => flag(style, 'i') || (style.getAttribute('u') && style.getAttribute('u') !== 'none') || (style.getAttribute('strike') && style.getAttribute('strike') !== 'noStrike') || attrNumber(style, 'baseline') !== 0 || style.hasAttribute('spc'))) slideWarn(`${clean(name)}: italic, underline, baseline, strike or custom character spacing is not retained.`);
      if (paragraphs.some(paragraph => ['lnSpc', 'spcBef', 'spcAft'].some(key => child(child(paragraph, 'pPr'), key)))) slideWarn(`${clean(name)}: custom paragraph spacing uses the editor’s standard line spacing.`);
      const fontReference = [shape, ...fallbacks].map(source => child(child(source, 'style'), 'fontRef')).find(Boolean) ?? null;
      const rawFont = styleChild('latin')?.getAttribute('typeface') || (fontReference?.getAttribute('idx') === 'major' ? '+mj-lt' : '+mn-lt');
      const resolvedFont = rawFont === '+mj-lt' ? current.theme.major : rawFont === '+mn-lt' ? current.theme.minor : rawFont;
      const font = DESIGN_FONTS.find(font => font.toLowerCase() === resolvedFont.toLowerCase()) ?? 'Arial';
      if (font.toLowerCase() !== resolvedFont.toLowerCase()) slideWarn(`Font “${clean(resolvedFont, 80)}” was mapped to Arial. Text wrapping may change.`);
      const styleSize = styleAttribute('sz'), pointSize = styleSize === null ? 18 : Number(styleSize) / 100;
      if (!Number.isFinite(pointSize) || pointSize <= 0) { skip(`${clean(name)}: the text size is invalid.`); return null; }
      const autofit = bodyProperties.map(properties => child(properties, 'normAutofit')).find(Boolean) ?? null, autoScale = attrNumber(autofit, 'fontScale', 100000) / 100000;
      if (autofit && (autoScale !== 1 || autofit.hasAttribute('lnSpcReduction'))) slideWarn(`${clean(name)}: text autofit was converted to a fixed font size; line wrapping may differ.`);
      const left = bodyNumber('lIns', 91440), top = bodyNumber('tIns', 45720), right = bodyNumber('rIns', 91440), bottom = bodyNumber('bIns', 45720);
      const inset = { x: left, y: top, width: frame.width - left - right, height: frame.height - top - bottom };
      const world = tryGeometry(frame, `${name} text`, current, inset); if (!world) return null;
      if (Math.abs(world.scaleX - world.scaleY) > Math.max(world.scaleX, world.scaleY) * 0.000001) { skip(`${clean(name)}: non-uniformly stretched text cannot be retained as an editable text box.`); return null; }
      const fontSize = rounded(pointSize * EMU_PER_POINT * world.scaleY * autoScale);
      if (fontSize < 6 || fontSize > 512) { skip(`${clean(name)}: text falls outside the supported 6–512 pixel font-size range.`); return null; }
      const alignment = paragraphStyles.map(properties => properties.getAttribute('algn')).find(value => value !== null) ?? 'l';
      if (!['l', 'ctr', 'r'].includes(alignment)) slideWarn(`${clean(name)}: justified or distributed text was mapped to left alignment.`);
      if (styleChild('noFill')) { skip(`${clean(name)}: outlined or unfilled text is not supported.`); return null; }
      if (['gradFill', 'blipFill', 'pattFill'].some(key => styleChild(key))) { skip(`${clean(name)}: gradient, patterned and image-filled text cannot be retained as editable text.`); return null; }
      const fill = colourFrom(styleChild('solidFill') ?? fontReference, current.theme, slideWarn) ?? current.theme.colours.get('dk1') ?? '#000000';
      const result: DesignElement = { ...world.base, type: 'text', text: content, fontFamily: font as DesignFont, fontSize, fontWeight: ['1', 'true'].includes(styleAttribute('b') ?? '') ? 700 : 400, textAlign: alignment === 'ctr' ? 'center' : alignment === 'r' ? 'right' : 'left', fill };
      // Measure with the same native renderer so vertical anchoring uses actual system-font metrics.
      const measured = await pageObjects({ id: uid(), name: 'Text measurement', background: '#ffffff', elements: [result] }, false);
      try {
        const actualHeight = measured[0]?.height ?? world.base.height;
        if (actualHeight > 16384) { skip(`${clean(name)}: the rendered text is too tall for the editor.`); return null; }
        const anchor = bodyAttribute('anchor') ?? 't', offset = anchor === 'ctr' ? (world.base.height - actualHeight) / 2 : anchor === 'b' ? world.base.height - actualHeight : 0;
        if (!['t', 'ctr', 'b'].includes(anchor)) slideWarn(`${clean(name)}: distributed vertical text alignment was mapped to top alignment.`);
        const angle = result.rotation * Math.PI / 180;
        result.x = rounded(result.x - Math.sin(angle) * offset); result.y = rounded(result.y + Math.cos(angle) * offset);
        result.height = rounded(actualHeight);
        if (Math.abs(result.x) > 16384 || Math.abs(result.y) > 16384 || result.height < 0.1) { skip(`${clean(name)}: its text position is outside the editor bounds.`); return null; }
      } finally { measured.forEach(object => object.dispose()); }
      return result;
    };

    const readNodes = async (nodes: Element[], current: Context, depth = 0, inherited = false): Promise<void> => {
      if (depth > MAX_DEPTH) throw new Error('The presentation has too many nested groups.');
      for (const node of nodes) {
        if (['nvGrpSpPr', 'grpSpPr', 'extLst'].includes(node.localName)) continue;
        const name = descendant(node, 'cNvPr')?.getAttribute('name') || `Imported ${node.localName}`;
        if (inherited && placeholder(node)) continue;
        const nodeContext = { ...current, visible: current.visible && !flag(descendant(node, 'cNvPr'), 'hidden') };
        if (node.localName === 'grpSp') {
          const matrix = groupTransform(node, current.matrix);
          if (!matrix) { skip(`${clean(name)}: a group transform is missing or invalid.`); continue; }
          if (current.groupId) slideWarn('Nested groups were flattened into their outer logical group.');
          effects(child(node, 'grpSpPr'), name);
          await readNodes(children(node), { ...nodeContext, matrix, groupId: current.groupId ?? uid() }, depth + 1, inherited);
          continue;
        }
        if (node.localName === 'AlternateContent') {
          const fallback = child(node, 'Fallback');
          if (!fallback) { skip('An alternate-content object has no supported fallback.'); continue; }
          slideWarn('An alternate-content object uses its supplied compatibility fallback.');
          await readNodes(children(fallback), nodeContext, depth + 1, inherited); continue;
        }
        if (node.localName === 'graphicFrame') {
          const uri = descendant(node, 'graphicData')?.getAttribute('uri') ?? '';
          skip(`${clean(name)}: ${uri.includes('chart') ? 'charts' : uri.includes('table') ? 'tables' : 'SmartArt or embedded graphics'} are not editable in this importer.`); continue;
        }
        if (node.localName !== 'sp' && node.localName !== 'pic') { skip(`${clean(name)}: ${clean(node.localName)} artwork is not supported.`); continue; }
        const fallbacks = placeholderShapes(node, nodeContext), properties = child(node, 'spPr');
        const inheritedTransform = fallbacks.map(fallback => child(child(fallback, 'spPr'), 'xfrm')).find(Boolean) ?? null;
        const frame = frameTransform(child(properties, 'xfrm') ?? inheritedTransform, current.matrix);
        if (!frame) { skip(`${clean(name)}: its position or size could not be resolved.`); continue; }
        effects(properties, name);
        const preset = child(properties, 'prstGeom')?.getAttribute('prst') ?? (child(properties, 'custGeom') ? 'custom' : 'rect');
        if (node.localName === 'pic') {
          if (preset !== 'rect') { skip(`${clean(name)}: a nonrectangular image mask cannot be retained.`); continue; }
          const fill = child(node, 'blipFill'), blip = child(fill, 'blip');
          const relation = current.relationships.get(relationshipId(blip, 'embed'));
          if (!relation?.target || relation.external || !relation.type.endsWith('/image')) { skip(`${clean(name)}: its image is missing, linked externally or unsupported.`); continue; }
          const world = tryGeometry(frame, name, nodeContext); if (!world) continue;
          let image: Raster;
          try {
            image = await raster(relation.target);
            const crop = child(fill, 'srcRect');
            if (crop && ['l', 't', 'r', 'b'].some(key => attrNumber(crop, key) !== 0)) {
              const cacheKey = `${relation.target}|${['l', 't', 'r', 'b'].map(key => attrNumber(crop, key)).join(',')}`;
              let pending = cropCache.get(cacheKey);
              if (!pending) { pending = croppedRaster(image, crop); cropCache.set(cacheKey, pending); }
              image = await pending; slideWarn(`${clean(name)}: the crop is baked into its embedded image; pixels outside the crop are not retained.`);
            }
          } catch (error) { skip(`${clean(name)}: ${error instanceof Error ? error.message : 'the embedded media could not be read'} Unsupported SVG, GIF, EMF and WMF media must be exported as PNG, JPEG or WebP.`); continue; }
          const alpha = child(blip, 'alphaModFix');
          if (alpha) world.base.opacity *= Math.max(0, Math.min(1, attrNumber(alpha, 'amt', 100000) / 100000));
          if (children(blip).some(effect => !['alphaModFix', 'extLst'].includes(effect.localName))) slideWarn(`${clean(name)}: image colour corrections and filters are not retained.`);
          if (child(fill, 'tile')) { skip(`${clean(name)}: tiled image fills are not supported.`); continue; }
          const fillRect = child(child(fill, 'stretch'), 'fillRect');
          if (fillRect && ['l', 't', 'r', 'b'].some(key => attrNumber(fillRect, key) !== 0)) { skip(`${clean(name)}: an inset image stretch is not supported.`); continue; }
          add({ ...world.base, type: 'image', src: image.src }); continue;
        }

        const shapeStyle = child(node, 'style'), fillReference = child(shapeStyle, 'fillRef');
        const fillProperties = [properties, ...fallbacks.map(fallback => child(fallback, 'spPr'))].find(source => source && ['solidFill', 'noFill', 'gradFill', 'blipFill', 'pattFill', 'grpFill'].some(key => child(source, key))) ?? properties;
        const solid = child(fillProperties, 'solidFill'), noFill = child(fillProperties, 'noFill');
        const fill = noFill ? null : colourFrom(solid ?? (attrNumber(fillReference, 'idx') > 0 ? fillReference : null), current.theme, slideWarn);
        if (!solid && !noFill && fill && fillReference) slideWarn(`${clean(name)}: a theme shape fill was simplified to its referenced solid colour.`);
        const hasText = Boolean(child(node, 'txBody')?.textContent?.trim());
        const shapeContext = { ...nodeContext, ...(fill && hasText && !nodeContext.groupId ? { groupId: uid() } : {}) };
        if (fill && ['rect', 'ellipse'].includes(preset)) {
          const world = tryGeometry(frame, name, shapeContext);
          if (world) add({ ...world.base, type: preset as 'rect' | 'ellipse', fill });
        } else if (fill || (!noFill && ['gradFill', 'blipFill', 'pattFill', 'grpFill'].some(key => child(fillProperties, key)))) skip(`${clean(name)}: ${['rect', 'ellipse'].includes(preset) ? 'a gradient, patterned or image-filled shape' : `the “${clean(preset)}” shape geometry`} was omitted; any supported text is retained separately.`);
        else if (!hasText && !noFill && preset !== 'rect') skip(`${clean(name)}: the shape has no supported solid fill or geometry.`);
        else if (!hasText && !fill && child(properties, 'ln') && !child(child(properties, 'ln'), 'noFill')) skip(`${clean(name)}: outline-only shapes are not supported.`);
        const text = await textElement(node, frame, shapeContext, name, fallbacks);
        if (text) add(text);
      }
    };

    let background = '#ffffff';
    for (const source of [slide, layout, master]) {
      const bg = child(child(source?.documentElement, 'cSld'), 'bg'); if (!bg) continue;
      const properties = child(bg, 'bgPr'), solid = child(properties, 'solidFill'), reference = child(bg, 'bgRef');
      const colour = colourFrom(solid ?? reference, theme, slideWarn);
      if (colour) { background = colour; if (reference) slideWarn('A theme background was reduced to its referenced solid colour.'); }
      else if (child(properties, 'noFill')) background = '#ffffff00';
      else { skipped++; slideWarn('An image, patterned or gradient slide background was not retained.'); }
      if (child(properties, 'effectLst')?.children.length) slideWarn('Background shadows and effects were not retained.');
      break;
    }
    const showMaster = !['0', 'false'].includes(slide.documentElement.getAttribute('showMasterSp') ?? '') && !['0', 'false'].includes(layout?.documentElement.getAttribute('showMasterSp') ?? '');
    if (master && masterPart && showMaster) await readNodes(children(child(child(master.documentElement, 'cSld'), 'spTree')), { ...context, part: masterPart, relationships: relationships(masterPart) }, 0, true);
    if (layout && layoutPart) await readNodes(children(child(child(layout.documentElement, 'cSld'), 'spTree')), { ...context, part: layoutPart, relationships: relationships(layoutPart) }, 0, true);
    await readNodes(children(child(child(slide.documentElement, 'cSld'), 'spTree')), context);
    if (descendant(slide, 'timing') || child(slide.documentElement, 'transition')) slideWarn('Animations and slide transitions are not retained.');
    if (!elements.some(element => element.visible && element.opacity > 0) && skipped) throw new Error(`Slide ${slideIndex + 1} has no supported visible artwork. Export that slide as SVG or PNG instead.`);
    pages.push({ id: uid(), name: clean(child(slide.documentElement, 'cSld')?.getAttribute('name') ?? '') || `Slide ${slideIndex + 1}`, background, elements });
  }
  if (pages.some(page => page.elements.some(element => element.type === 'text'))) warn('PowerPoint text uses the editor’s text engine. Review fonts, wrapping, spacing and line breaks against the Canva original.');
  if (extraWarnings) warnings.push(`${extraWarnings} additional import warnings were omitted from this summary.`);
  const checked = validateDesignDocument({ format: 'open-design-studio', version: 1, width, height, pages });
  const title = clean(descendant(xml('docProps/core.xml'), 'title')?.textContent ?? '') || clean(file.name.replace(/\.[^.]+$/, '')) || 'Imported Canva presentation';
  return { title, width: checked.width, height: checked.height, pages: checked.pages, warnings };
}
