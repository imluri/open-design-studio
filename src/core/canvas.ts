import type { Canvas, FabricObject, StaticCanvas, Textbox } from 'fabric';
import type { DesignDocument, DesignElement, DesignPage } from './model';
import { DESIGN_MAX_IMAGE_BYTES, DESIGN_MAX_IMAGE_PIXELS, DESIGN_MAX_IMAGE_SIDE, validateDesignDocument, validateImageSource } from './model';

export type LayerObject = FabricObject & { studioId?: string };
export type ExportFormat = 'png' | 'jpeg' | 'svg';

const MAX_PAGE_IMAGE_PIXELS = 64_000_000;
const MAX_EXPORT_PIXELS = 32_000_000;
const MAX_ZIP_BYTES = 120 * 1024 * 1024;
const MAX_ZIP_RASTER_BYTES = 128 * 1024 * 1024;
const round = (value: number) => Math.round(value * 100) / 100;
const bounded = (value: number, fallback: number, min: number, max: number) => Number.isFinite(value) ? Math.max(min, Math.min(max, round(value))) : fallback;

function readDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('The image could not be read.'));
    reader.onerror = () => reject(new Error('The image could not be read.'));
    reader.onabort = () => reject(new Error('Reading the image was cancelled.'));
    reader.readAsDataURL(blob);
  });
}

/** Only validated embedded raster sources reach the browser image decoder. */
function decodeImage(source: string): Promise<HTMLImageElement> {
  const src = validateImageSource(source);
  return new Promise((resolve, reject) => {
    const image = new Image();
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      image.onload = null; image.onerror = null;
      if (error) { image.removeAttribute('src'); reject(error); }
      else resolve(image);
    };
    const timer = window.setTimeout(() => finish(new Error('The image took too long to open. Try a smaller image.')), 15000);
    image.onload = () => {
      const width = image.naturalWidth, height = image.naturalHeight;
      if (!width || !height || width > DESIGN_MAX_IMAGE_SIDE || height > DESIGN_MAX_IMAGE_SIDE || width * height > DESIGN_MAX_IMAGE_PIXELS) {
        finish(new Error('Use an image no larger than 8192 pixels per side and 32 megapixels.'));
      } else finish();
    };
    image.onerror = () => finish(new Error('This image could not be decoded. Choose a standard PNG, JPEG or WebP file.'));
    image.decoding = 'async';
    image.src = src;
  });
}

/** Keep original bytes and proportions. No upload, remote URL or image conversion is performed. */
export async function importImage(file: File): Promise<{ src: string; width: number; height: number; name: string }> {
  if (!file.size || file.size > DESIGN_MAX_IMAGE_BYTES) throw new Error('Choose a PNG, JPEG or WebP image under 10 MB.');
  const signature = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const ascii = (start: number, end: number) => String.fromCharCode(...signature.slice(start, end));
  const type = [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => signature[index] === byte) ? 'image/png'
    : signature[0] === 255 && signature[1] === 216 && signature[2] === 255 ? 'image/jpeg'
      : ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP' ? 'image/webp' : '';
  if (!type || (file.type && file.type.toLowerCase() !== type)) throw new Error('The file contents must match its PNG, JPEG or WebP image type.');
  const src = validateImageSource(await readDataUrl(new Blob([file], { type })));
  const image = await decodeImage(src);
  return {
    src, width: image.naturalWidth, height: image.naturalHeight,
    name: file.name.replace(/\.[^.]+$/, '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 160) || 'Uploaded image',
  };
}

async function loadFonts(page: DesignPage): Promise<void> {
  if (!globalThis.document?.fonts) return;
  const requests = new Map<string, string>();
  for (const element of page.elements) if (element.type === 'text') {
    const key = `${element.fontWeight} 48px "${element.fontFamily}"`;
    requests.set(key, (requests.get(key) ?? 'BESbswy') + element.text);
  }
  await Promise.all([...requests].map(async ([font, sample]) => {
    try { await globalThis.document.fonts.load(font, sample); }
    catch { throw new Error('A design font could not be loaded. Choose an available system font.'); }
  }));
}

/** Build objects from our document model, never Fabric's executable JSON object graph. */
export async function pageObjects(page: DesignPage, editable: boolean): Promise<LayerObject[]> {
  const { Rect, Ellipse, Textbox, FabricImage } = await import('fabric');
  await loadFonts(page);
  const objects: LayerObject[] = [];
  const images = new Map<string, HTMLImageElement>();
  let imagePixels = 0;
  try {
    for (const element of page.elements) {
      const options = {
        left: element.x, top: element.y, originX: 'left' as const, originY: 'top' as const,
        angle: element.rotation, opacity: element.opacity, visible: element.visible,
        selectable: editable && !element.locked, evented: editable && !element.locked,
        lockMovementX: element.locked, lockMovementY: element.locked,
        lockScalingX: element.locked, lockScalingY: element.locked, lockRotation: element.locked,
        lockScalingFlip: true, strokeWidth: 0, padding: 5,
        cornerColor: '#555555', borderColor: '#555555', cornerStrokeColor: '#ffffff',
        transparentCorners: false, cornerStyle: 'circle' as const,
      };
      let object: LayerObject;
      if (element.type === 'text') {
        object = new Textbox(element.text, {
          ...options, width: element.width, fontSize: element.fontSize, fontFamily: element.fontFamily,
          fontWeight: element.fontWeight, textAlign: element.textAlign, fill: element.fill ?? '#20242c',
          charSpacing: (element.letterSpacing ?? 0) / element.fontSize * 1000,
          lineHeight: 1.12, splitByGrapheme: false,
        });
      } else if (element.type === 'image') {
        let image = images.get(element.src);
        if (!image) {
          image = await decodeImage(element.src);
          imagePixels += image.naturalWidth * image.naturalHeight;
          if (imagePixels > MAX_PAGE_IMAGE_PIXELS) throw new Error('This page has too many large images. Use smaller source images or split them across pages.');
          images.set(element.src, image);
        }
        object = new FabricImage(image, {
          ...options, scaleX: element.width / image.naturalWidth, scaleY: element.height / image.naturalHeight,
        });
      } else if (element.type === 'ellipse') {
        object = new Ellipse({ ...options, rx: element.width / 2, ry: element.height / 2, fill: element.fill ?? '#6656db' });
      } else {
        object = new Rect({ ...options, width: element.width, height: element.height, rx: element.borderRadius ?? 0, ry: element.borderRadius ?? 0, fill: element.fill ?? '#6656db' });
      }
      object.studioId = element.id;
      objects.push(object);
    }
    return objects;
  } catch (error) {
    objects.forEach(object => object.dispose());
    throw error;
  }
}

/** Capture visual transforms while retaining model-only fields and any unloaded layers. */
export function readCanvasPage(canvas: Canvas, page: DesignPage): DesignPage {
  const originals = new Map(page.elements.map(element => [element.id, element]));
  const captured = new Map<string, DesignElement>();
  for (const object of canvas.getObjects() as LayerObject[]) {
    const original = originals.get(object.studioId ?? '');
    if (!original || captured.has(original.id)) continue;
    const element: DesignElement = {
      ...original,
      x: bounded(object.left, original.x, -16384, 16384), y: bounded(object.top, original.y, -16384, 16384),
      width: bounded(Math.abs(object.width * object.scaleX), original.width, 0.1, 16384),
      height: bounded(Math.abs(object.height * object.scaleY), original.height, 0.1, 16384),
      rotation: Number.isFinite(object.angle) ? round(((object.angle + 180) % 360 + 360) % 360 - 180) : original.rotation,
      opacity: bounded(object.opacity, original.opacity, 0, 1), visible: object.visible,
    };
    if (element.type === 'text') {
      const text = object as Textbox;
      element.text = text.text;
      element.fontSize = bounded(text.fontSize * Math.abs(text.scaleY), element.fontSize, 6, 512);
      element.letterSpacing = bounded(text.charSpacing * text.fontSize / 1000 * Math.abs(text.scaleX), element.letterSpacing ?? 0, -10, 100);
    } else if (element.type === 'rect' && 'rx' in object) {
      element.borderRadius = bounded(Number(object.rx) * Math.min(Math.abs(object.scaleX), Math.abs(object.scaleY)), element.borderRadius ?? 0, 0, 2048);
    }
    captured.set(element.id, element);
  }
  const elements = captured.size === page.elements.length
    ? [...captured.values()]
    : page.elements.map(element => captured.get(element.id) ?? { ...element });
  return { ...page, elements };
}

function exportSettings(document: DesignDocument, format: ExportFormat, resolution: 1 | 2) {
  if (!['png', 'jpeg', 'svg'].includes(format) || (resolution !== 1 && resolution !== 2)) throw new Error('Choose a supported export format and resolution.');
  if (format !== 'svg' && document.width * document.height * resolution * resolution > MAX_EXPORT_PIXELS) throw new Error('This export exceeds 32 megapixels. Choose standard resolution or a smaller canvas.');
}

async function renderPage(document: DesignDocument, index: number, format: ExportFormat, resolution: 1 | 2): Promise<Blob> {
  const page = document.pages[index];
  if (!page || !Number.isInteger(index)) throw new Error('Choose an existing page to export.');
  const { StaticCanvas, Rect } = await import('fabric');
  const canvas: StaticCanvas = new StaticCanvas(undefined, { width: document.width, height: document.height, enableRetinaScaling: false, renderOnAddRemove: false });
  try {
    if (format === 'jpeg') {
      canvas.backgroundColor = '#ffffff';
      canvas.add(new Rect({ left: 0, top: 0, originX: 'left', originY: 'top', width: document.width, height: document.height, fill: page.background, strokeWidth: 0 }));
    } else canvas.backgroundColor = page.background;
    canvas.add(...await pageObjects(page, false));
    canvas.renderAll();
    if (format === 'svg') return new Blob([canvas.toSVG()], { type: 'image/svg+xml' });
    const blob = await canvas.toBlob({ format, quality: 1, multiplier: resolution, enableRetinaScaling: false });
    if (!blob) throw new Error('This page could not be exported.');
    return blob;
  } finally { await canvas.dispose(); }
}

export async function exportPage(document: DesignDocument, index: number, format: ExportFormat, resolution: 1 | 2 = 1): Promise<Blob> {
  const snapshot = validateDesignDocument(document);
  exportSettings(snapshot, format, resolution);
  return renderPage(snapshot, index, format, resolution);
}

export async function exportPages(document: DesignDocument, format: ExportFormat, resolution: 1 | 2 = 1): Promise<Blob> {
  const snapshot = validateDesignDocument(document);
  exportSettings(snapshot, format, resolution);
  if (format !== 'svg' && snapshot.width * snapshot.height * resolution * resolution * 4 * snapshot.pages.length > MAX_ZIP_RASTER_BYTES) {
    throw new Error('This carousel is too large to export at once. Use standard resolution, a smaller canvas, or export individual pages.');
  }
  const { strToU8, zip } = await import('fflate');
  const files: Record<string, Uint8Array> = {};
  let bytes = 0;
  const extension = format === 'jpeg' ? 'jpg' : format;
  for (let index = 0; index < snapshot.pages.length; index++) {
    const blob = await renderPage(snapshot, index, format, resolution);
    bytes += blob.size;
    if (bytes > MAX_ZIP_BYTES) throw new Error('The exported files exceed 120 MB. Export fewer pages or use a lower resolution.');
    files[`page-${String(index + 1).padStart(2, '0')}-${designFilename(snapshot.pages[index].name)}.${extension}`] = new Uint8Array(await blob.arrayBuffer());
  }
  const multiplier = format === 'svg' ? 1 : resolution;
  files['README.txt'] = strToU8(`Open Design Studio\n${snapshot.width * multiplier} x ${snapshot.height * multiplier} pixels\nPages are ordered by number.\nSVG contains vector shapes, embedded raster artwork and system font names. Install the design fonts to preserve text appearance.\nJPEG transparency is flattened onto white.\nKeep an editable project JSON separately to preserve the original layer model.\n`);
  const archive = await new Promise<Uint8Array>((resolve, reject) => {
    zip(files, { level: format === 'svg' ? 6 : 0 }, (error, data) => error ? reject(new Error('The ZIP could not be created. Try exporting individual pages.')) : resolve(data));
  });
  return new Blob([new Uint8Array(archive).buffer], { type: 'application/zip' });
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = globalThis.document.createElement('a');
  link.href = url; link.download = name;
  globalThis.document.body.append(link);
  link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function designFilename(title: string): string {
  const slug = Array.from(title.normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').toLowerCase()).slice(0, 80).join('') || 'design';
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(slug) ? `design-${slug}` : slug;
}
