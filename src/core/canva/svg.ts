import { Circle, Color, Ellipse, FabricImage, FabricText, Rect, Textbox, loadSVGFromString } from 'fabric';
import type { FabricObject } from 'fabric';
import { readObjectWorldTransform } from '../canvas';
import { DESIGN_FONTS, DESIGN_MAX_ELEMENTS, DESIGN_MAX_IMAGE_BYTES, DESIGN_MAX_IMAGE_PIXELS, DESIGN_MAX_IMAGE_SIDE, validateDesignDocument, validateImageSource } from '../model';
import type { DesignElement, DesignFont, DesignPage } from '../model';
import type { CanvaPageSet } from './types';

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_NODES = 10000;
const MAX_IMAGE_PIXELS_TOTAL = 64_000_000;
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const allowedTags = new Set(('svg g defs title desc metadata rect ellipse circle text tspan image path polygon polyline line clipPath mask linearGradient radialGradient stop pattern filter feBlend feColorMatrix feComponentTransfer feComposite feConvolveMatrix feDiffuseLighting feDisplacementMap feDistantLight feDropShadow feFlood feFuncA feFuncB feFuncG feFuncR feGaussianBlur feImage feMerge feMergeNode feMorphology feOffset fePointLight feSpecularLighting feSpotLight feTile feTurbulence use symbol marker style textPath switch a').toLowerCase().split(' '));
const drawableTags = new Set(['rect', 'ellipse', 'circle', 'text', 'image']);
const cssProperties = new Set(('fill fill-opacity fill-rule clip-path clip-rule stroke stroke-opacity stroke-width stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset opacity display visibility font font-family font-size font-weight font-style font-stretch font-variant font-feature-settings font-kerning font-variant-ligatures font-variant-caps text-anchor text-decoration text-transform letter-spacing word-spacing line-height dominant-baseline alignment-baseline baseline-shift direction unicode-bidi writing-mode white-space color stop-color stop-opacity flood-color flood-opacity lighting-color filter mask isolation mix-blend-mode paint-order vector-effect overflow transform transform-origin transform-box image-rendering shape-rendering text-rendering color-interpolation color-interpolation-filters color-rendering enable-background clip mask-type text-orientation x y cx cy r rx ry width height').split(' '));
const nativeProperties = new Set(['fill', 'fill-opacity', 'fill-rule', 'opacity', 'display', 'font-family', 'font-size', 'font-weight', 'letter-spacing', 'text-anchor', 'stroke-width']);
const harmlessProperties = new Set(['id', 'class', 'transform', 'x', 'y', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height', 'version', 'viewbox', 'preserveaspectratio', 'href', 'xmlns']);
const uid = () => crypto.randomUUID().replaceAll('-', '');
const cleanName = (value: string, fallback: string) => value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 160) || fallback;
const round = (value: number) => Math.round(value * 10000) / 10000;
const fail = (message: string): never => { throw new Error(message); };

interface SanitizedSvg {
  root: Element;
  width: number;
  height: number;
  reasons: Set<string>;
  warnings: Set<string>;
  images: Map<string, number>;
}

function mapFont(value: string, warnings: Set<string>): DesignFont {
  let substituted = false;
  const chosen = (font: DesignFont) => {
    if (substituted) warnings.add('Unavailable source fonts were replaced with supported system fonts. No external fonts were loaded.');
    return font;
  };
  for (const raw of value.split(',')) {
    const family = raw.trim().replace(/^['"]|['"]$/g, '').trim();
    const known = DESIGN_FONTS.find(font => font.toLowerCase() === family.toLowerCase());
    if (known) return chosen(known);
    const generic = family.toLowerCase();
    if (generic === 'serif' || generic === 'ui-serif') return chosen('Times New Roman');
    if (generic === 'monospace' || generic === 'ui-monospace') return chosen('Courier New');
    if (['sans-serif', 'system-ui', 'ui-sans-serif'].includes(generic)) return chosen('Arial');
    substituted = true;
  }
  warnings.add('Unavailable source fonts were replaced with Arial. No external fonts were loaded.');
  return 'Arial';
}

/** CSS escapes, imports and every URL except a document-local fragment are forbidden. */
function checkResourceValue(value: string): void {
  if (/[\\\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) || /@|(?:expression|var|env)\s*\(|(?:javascript|vbscript|https?|ftp|file|blob|data)\s*:|\/\//i.test(value)) fail('This SVG contains external or unsafe resources. Export a self-contained SVG with embedded images.');
  const remaining = value.replace(/url\(\s*(['"]?)(#[A-Za-z0-9_.:-]{1,128})\1\s*\)/gi, '');
  if (/url\s*\(/i.test(remaining)) fail('SVG paint and effect URLs must reference an ID within this file.');
}

function feature(property: string, value: string, container: boolean, reasons: Set<string>, css = false): void {
  const key = property.toLowerCase(), normalized = value.trim().toLowerCase();
  if (!css && harmlessProperties.has(key)) return;
  if (key === 'opacity' && container && Number(normalized) !== 1) reasons.add('container opacity');
  if (key === 'stroke' && normalized !== 'none') reasons.add('strokes');
  else if (key === 'font-style' && normalized !== 'normal') reasons.add('styled text');
  else if (key === 'font-weight' && !['400', '700', 'normal', 'bold'].includes(normalized)) reasons.add('additional font weights');
  else if (key === 'visibility' && normalized !== 'visible') reasons.add('visibility rules');
  else if (['clip-path', 'filter', 'mask'].includes(key) && normalized !== 'none') reasons.add('clipping, masks or effects');
  else if (key === 'text-decoration' && normalized !== 'none') reasons.add('text decorations');
  else if (['font-style', 'stroke', 'visibility', 'clip-path', 'filter', 'mask', 'text-decoration'].includes(key)) { /* Explicit defaults do not change simple layers. */ }
  else if (cssProperties.has(key) && !nativeProperties.has(key)) reasons.add('advanced SVG formatting');
  if (/url\s*\(|currentcolor|context-(?:fill|stroke)|\binherit\b/i.test(value)) reasons.add('inherited or referenced paint');
}

function declarations(source: string, warnings: Set<string>, reasons: Set<string>, container = false): string {
  if (/\/\*|\*\//.test(source)) {
    const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '');
    if (/\/\*|\*\//.test(stripped)) fail('This SVG contains an invalid CSS comment.');
    source = stripped;
  }
  return source.split(';').map(declaration => {
    if (!declaration.trim()) return '';
    const match = /^\s*([a-z-]+)\s*:\s*([^{}]+?)\s*$/i.exec(declaration);
    if (!match) return fail('This SVG contains unsupported CSS syntax. Export plain SVG or PDF instead.');
    const property = match[1].toLowerCase();
    if (!cssProperties.has(property)) fail(`The SVG CSS property “${property}” is not supported safely.`);
    let value = match[2].trim();
    checkResourceValue(value);
    const important = /!\s*important\s*$/i.test(value);
    if (important) { reasons.add('CSS priority rules'); value = value.replace(/!\s*important\s*$/i, '').trim(); }
    if (value.length > 4096 || !value) fail('This SVG contains an invalid or oversized CSS value.');
    if (property === 'font-family') value = mapFont(value, warnings);
    if (property === 'font') {
      const style = document.createElement('span').style;
      style.font = value;
      if (!style.font || !style.fontFamily) fail('This SVG contains an unsupported font shorthand.');
      style.fontFamily = mapFont(style.fontFamily, warnings); value = style.font;
    }
    feature(property, value, container, reasons, true);
    return `${property}:${value}${important ? ' !important' : ''}`;
  }).filter(Boolean).join(';');
}

function stylesheet(source: string, warnings: Set<string>, reasons: Set<string>): string {
  source = source.replace(/\/\*[\s\S]*?\*\//g, '');
  if (/[\\@]|\/\*|\*\//.test(source)) fail('SVG stylesheets cannot contain imports, embedded fonts, escapes or at-rules.');
  const rules: string[] = [];
  let consumed = 0;
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    if (source.slice(consumed, match.index).trim()) fail('This SVG contains unsupported stylesheet syntax.');
    const selector = match[1].trim();
    if (selector.length > 2048 || !/^[\w\s.#*,:\[\]="'()^$|~+>\-]+$/.test(selector)) fail('This SVG contains unsupported CSS selectors.');
    rules.push(`${selector}{${declarations(match[2], warnings, reasons)}}`);
    if (rules.length > 1000) fail('This SVG contains too many stylesheet rules.');
    consumed = pattern.lastIndex;
  }
  if (source.slice(consumed).trim()) fail('This SVG contains invalid stylesheet syntax.');
  if (rules.length) reasons.add('stylesheet-based formatting');
  return rules.join('\n');
}

function pageSize(root: Element): { width: number; height: number; viewBox: string } {
  const viewBox = root.getAttribute('viewBox');
  const values = viewBox?.trim().split(/[\s,]+/).map(Number);
  if (values && (values.length !== 4 || !values.every(Number.isFinite) || values[2] <= 0 || values[3] <= 0 || values.some(value => Math.abs(value) > 1e7))) fail('The SVG viewBox is invalid or too large.');
  const dimension = (raw: string | null): number | undefined => {
    if (!raw || raw.trim().endsWith('%')) return undefined;
    const match = /^\s*(\d*\.?\d+(?:e[+-]?\d+)?)\s*(px|pt|pc|in|cm|mm)?\s*$/i.exec(raw);
    if (!match) return fail('SVG page dimensions must use positive pixel or physical units.');
    const factor: Record<string, number> = { px: 1, pt: 96 / 72, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4 };
    return Number(match[1]) * (factor[(match[2] || 'px').toLowerCase()]);
  };
  let width = dimension(root.getAttribute('width')), height = dimension(root.getAttribute('height'));
  if (values) {
    if (width && !height) height = width * values[3] / values[2];
    if (height && !width) width = height * values[2] / values[3];
    width ??= values[2]; height ??= values[3];
  }
  if (!width || !height || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return fail('The SVG needs a width and height or a valid viewBox.');
  if (width > DESIGN_MAX_IMAGE_SIDE || height > DESIGN_MAX_IMAGE_SIDE || width * height > DESIGN_MAX_IMAGE_PIXELS) fail('The original SVG page must be at most 8,192 pixels per side and 32 megapixels.');
  return { width, height, viewBox: values ? values.join(' ') : `0 0 ${width} ${height}` };
}

function outputSize(width: number, height: number): { width: number; height: number } {
  const minimum = 320 / Math.min(width, height), maximum = 4096 / Math.max(width, height);
  if (minimum > maximum + 1e-8) fail('This SVG is too wide or tall for the editor. Use a page aspect ratio between 1:12.8 and 12.8:1.');
  const factor = Math.max(minimum, Math.min(1, maximum));
  return { width: Math.max(320, Math.min(4096, Math.round(width * factor))), height: Math.max(320, Math.min(4096, Math.round(height * factor))) };
}

function resourceInstances(root: Element): Map<string, number> {
  const byId = new Map(Array.from(root.querySelectorAll('[id]')).map(element => [element.getAttribute('id')!, element]));
  const images = new Map<string, number>(), ancestors = new Set<Element>();
  let expanded = 0;
  const visit = (element: Element, referenceDepth: number) => {
    if (++expanded > 30000 || referenceDepth > 8 || ancestors.has(element)) fail('The SVG has cyclic or excessively repeated resource references.');
    ancestors.add(element);
    const tag = element.localName.toLowerCase(), href = element.getAttribute('href');
    if (href && ['image', 'feimage'].includes(tag)) images.set(href, (images.get(href) ?? 0) + 1);
    const references = new Set<string>();
    if (href?.startsWith('#') && tag !== 'a') references.add(href.slice(1));
    for (const attribute of Array.from(element.attributes)) {
      for (const match of attribute.value.matchAll(/url\(\s*['"]?#([A-Za-z0-9_.:-]{1,128})['"]?\s*\)/gi)) references.add(match[1]);
    }
    for (const id of references) {
      const target = byId.get(id);
      if (!target) fail('The SVG refers to a missing local resource.');
      visit(target!, referenceDepth + 1);
    }
    for (const child of Array.from(element.children)) visit(child, referenceDepth);
    ancestors.delete(element);
  };
  visit(root, 0);
  return images;
}

function checkFilterRegions(root: Element, width: number, height: number, viewBox: string): void {
  const units = viewBox.split(' ').map(Number);
  for (const filter of Array.from(root.querySelectorAll('filter'))) {
    const userSpace = filter.getAttribute('filterUnits') === 'userSpaceOnUse';
    const dimension = (name: 'x' | 'y' | 'width' | 'height', fallback: number) => {
      const raw = filter.getAttribute(name);
      if (raw === null) return fallback;
      const match = /^\s*([-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?)\s*(%|px)?\s*$/i.exec(raw);
      if (!match || !Number.isFinite(Number(match[1]))) return fail('This SVG has an invalid filter region.');
      const vertical = name === 'y' || name === 'height', pageSide = vertical ? height : width;
      const amount = Number(match[1]);
      if (match[2] === '%') {
        if (Math.abs(amount) > 400) fail('The SVG filter region is too large.');
        return amount / 100 * pageSide;
      }
      if (!userSpace) {
        if (match[2] || Math.abs(amount) > 4) fail('The SVG object-bounding-box filter region is too large.');
        return amount * pageSide;
      }
      const pixels = amount * pageSide / units[vertical ? 3 : 2];
      if (Math.abs(pixels) > DESIGN_MAX_IMAGE_SIDE) fail('The SVG filter region exceeds 8,192 pixels.');
      return pixels;
    };
    const x = dimension('x', -width / 10), y = dimension('y', -height / 10);
    const regionWidth = dimension('width', width * 1.2), regionHeight = dimension('height', height * 1.2);
    if (![x, y, regionWidth, regionHeight].every(Number.isFinite) || regionWidth <= 0 || regionHeight <= 0 || regionWidth > DESIGN_MAX_IMAGE_SIDE || regionHeight > DESIGN_MAX_IMAGE_SIDE || regionWidth * regionHeight > DESIGN_MAX_IMAGE_PIXELS) fail('An SVG filter region exceeds the 32-megapixel image budget.');
    if (filter.getAttribute('primitiveUnits') && !['userSpaceOnUse', 'objectBoundingBox'].includes(filter.getAttribute('primitiveUnits')!)) fail('This SVG has invalid filter primitive units.');
    if (filter.getAttribute('filterUnits') && !['userSpaceOnUse', 'objectBoundingBox'].includes(filter.getAttribute('filterUnits')!)) fail('This SVG has invalid filter units.');
  }
}

function sanitize(source: string): SanitizedSvg {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source) || /<\?(?!xml(?:\s|\?>))/i.test(source)) fail('SVG document types, entities and processing instructions are not supported.');
  const parsed = new DOMParser().parseFromString(source, 'image/svg+xml');
  if (parsed.getElementsByTagName('parsererror').length || parsed.documentElement.localName.toLowerCase() !== 'svg') fail('This file is not a valid SVG image.');
  const namespace = parsed.documentElement.namespaceURI;
  if (namespace && namespace !== SVG_NS) fail('The SVG uses an invalid root namespace.');
  const pending: Array<{ node: Node; depth: number }> = [{ node: parsed.documentElement, depth: 0 }];
  let originalNodes = 0;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (++originalNodes > MAX_NODES || depth > 64) fail('This SVG exceeds 10,000 XML nodes or 64 nested levels.');
    for (const child of Array.from(node.childNodes)) pending.push({ node: child, depth: depth + 1 });
  }
  const canonical = document.implementation.createDocument(SVG_NS, 'svg', null);
  const warnings = new Set<string>(), reasons = new Set<string>(), ids = new Set<string>();
  let nodes = 0, uses = 0, filters = 0;
  const copy = (node: Node, depth: number): Node | null => {
    if (++nodes > MAX_NODES || depth > 64) return fail('This SVG is too complex. Use at most 10,000 XML nodes and 64 nested levels.');
    if (node.nodeType === Node.PROCESSING_INSTRUCTION_NODE || node.nodeType === Node.DOCUMENT_TYPE_NODE || node.nodeType === Node.ENTITY_REFERENCE_NODE) return fail('This SVG contains unsupported XML instructions.');
    if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE) return canonical.createTextNode(node.textContent ?? '');
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    const element = node as Element, tag = element.localName.toLowerCase();
    if (tag === 'script' || tag === 'foreignobject') fail('Scripts and embedded HTML are not allowed in SVG imports.');
    if (element.namespaceURI !== SVG_NS && !(namespace === null && element.namespaceURI === null)) fail('This SVG contains a foreign XML namespace.');
    if (!allowedTags.has(tag)) fail(`The SVG element “${element.localName}” is not supported safely.`);
    if (element.attributes.length > 64) fail('An SVG element contains too many attributes.');
    if (tag === 'use' && ++uses > 128) fail('This SVG contains too many symbol references.');
    if (tag === 'filter' && ++filters > 24) fail('This SVG contains too many image effects.');
    const target = canonical.createElementNS(SVG_NS, element.localName);
    const container = ['svg', 'g', 'symbol', 'a'].includes(tag);
    let href: string | null = null;
    for (const attribute of Array.from(element.attributes)) {
      const key = attribute.localName.toLowerCase(), value = attribute.value;
      if (/^on/i.test(key) || ['src', 'srcset', 'poster'].includes(key) || (attribute.namespaceURI === XML_NS && key === 'base')) fail('This SVG contains event handlers or unsafe resource attributes.');
      if (attribute.namespaceURI === XMLNS_NS) {
        if (![SVG_NS, XLINK_NS, XML_NS].includes(value)) fail('This SVG declares an unsupported XML namespace.');
        continue;
      }
      if (attribute.namespaceURI && attribute.namespaceURI !== XLINK_NS && attribute.namespaceURI !== XML_NS) fail('This SVG contains an unsupported attribute namespace.');
      if (attribute.namespaceURI === XLINK_NS && key !== 'href') fail('Only xlink:href is supported in SVG resource attributes.');
      if (key === 'href') {
        let resource = value.trim();
        if (['image', 'feimage'].includes(tag)) {
          resource = validateImageSource(resource.replace(/[\t\n\r ]/g, ''));
        } else if (!/^#[A-Za-z0-9_.:-]{1,128}$/.test(resource) || !['use', 'lineargradient', 'radialgradient', 'pattern', 'textpath', 'a'].includes(tag)) fail('SVG references must be local fragments; images must be embedded PNG, JPEG or WebP files.');
        if (href !== null && href !== resource) fail('This SVG contains conflicting image or symbol references.');
        href = resource; continue;
      }
      if (['crossorigin', 'tabindex', 'focusable', 'externalresourcesrequired'].includes(key)) continue;
      if (key === 'id') {
        if (!ID.test(value) || ids.has(value)) fail('SVG IDs must be unique, simple identifiers of at most 128 characters.');
        ids.add(value);
      }
      if (key === 'style') { target.setAttribute('style', declarations(value, warnings, reasons, container)); continue; }
      if (key === 'font-family') { checkResourceValue(value); target.setAttribute('font-family', mapFont(value, warnings)); continue; }
      if (key === 'font') fail('Use font attributes rather than the SVG font attribute.');
      if (attribute.namespaceURI === XML_NS) {
        if (!['space', 'lang'].includes(key)) fail('This SVG contains an unsupported XML attribute.');
        if (key === 'space' && value === 'preserve') reasons.add('preserved text spacing');
        target.setAttributeNS(XML_NS, `xml:${key}`, value); continue;
      }
      if (value.length > 2 * 1024 * 1024) fail('An SVG attribute is too large.');
      checkResourceValue(value);
      feature(key, value, container, reasons);
      if (!harmlessProperties.has(key) && !cssProperties.has(key) && ['textlength', 'lengthadjust', 'dx', 'dy', 'rotate'].includes(key)) reasons.add('positioned text');
      // Prevent unreasonable filter regions or numeric overflow before decoding.
      if (/^(?:stddeviation|radius|scale|kernelunitlength)$/i.test(key) && value.split(/[\s,]+/).some(part => !Number.isFinite(Number(part)) || Math.abs(Number(part)) > 128)) fail('This SVG contains an oversized image effect.');
      if (/^(?:x|y|width|height)$/i.test(key) && tag.startsWith('fe') && value.split(/[\s,]+/).some(part => Math.abs(parseFloat(part)) > 8192)) fail('This SVG contains an oversized filter region.');
      target.setAttribute(attribute.name, value);
    }
    if (href !== null) {
      target.setAttribute('href', href);
      target.setAttributeNS(XLINK_NS, 'xlink:href', href);
    } else if (['image', 'feimage', 'use', 'textpath'].includes(tag)) fail('An SVG image or reference is missing its embedded source.');
    if (tag === 'style') target.textContent = stylesheet(element.textContent ?? '', warnings, reasons);
    else for (const child of Array.from(element.childNodes)) { const result = copy(child, depth + 1); if (result) target.appendChild(result); }
    if (tag === 'path') reasons.add('paths or outlined artwork');
    else if (['filter', 'mask', 'clippath', 'lineargradient', 'radialgradient', 'pattern', 'marker'].includes(tag)) reasons.add('gradients, clipping or effects');
    else if (['line', 'polygon', 'polyline', 'use', 'symbol', 'switch', 'a'].includes(tag)) reasons.add('additional vector geometry');
    else if (['tspan', 'textpath'].includes(tag)) reasons.add('complex text layout');
    else if (tag === 'svg' && depth > 0) reasons.add('nested SVG viewports');
    return target;
  };
  const root = copy(parsed.documentElement, 0) as Element;
  canonical.replaceChild(root, canonical.documentElement);
  const original = pageSize(root), output = outputSize(original.width, original.height);
  if (Math.abs(output.width - original.width) > 0.01 || Math.abs(output.height - original.height) > 0.01) warnings.add(`Page size was fitted to ${output.width} × ${output.height} pixels, preserving its aspect ratio to the nearest pixel.`);
  root.setAttribute('width', String(output.width)); root.setAttribute('height', String(output.height)); root.setAttribute('viewBox', original.viewBox);
  if (!root.hasAttribute('font-family')) root.setAttribute('font-family', 'Times New Roman');
  checkFilterRegions(root, output.width, output.height, original.viewBox);
  const images = resourceInstances(root);
  return { root, ...output, reasons, warnings, images };
}

async function decode(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; window.clearTimeout(timer); image.onload = null; image.onerror = null;
      if (error) { image.removeAttribute('src'); reject(error); } else resolve(image);
    };
    const timer = window.setTimeout(() => finish(new Error('The SVG or one of its images took too long to decode. Export a simpler SVG or PDF.')), 15000);
    image.onload = () => {
      const width = image.naturalWidth, height = image.naturalHeight;
      if (!width || !height || width > DESIGN_MAX_IMAGE_SIDE || height > DESIGN_MAX_IMAGE_SIDE || width * height > DESIGN_MAX_IMAGE_PIXELS) finish(new Error('An SVG image exceeds the supported pixel limits.'));
      else finish();
    };
    image.onerror = () => finish(new Error('The SVG or an embedded image could not be decoded. Export it again from Canva.'));
    image.decoding = 'async'; image.src = source;
  });
}

/** Sources have already passed the shared signature/header validator. Budget
 * their declared dimensions before asking the browser to allocate decoded data. */
function declaredImagePixels(source: string): number {
  const binary = atob(source.slice(source.indexOf(',') + 1));
  const byte = (at: number) => binary.charCodeAt(at);
  const u16 = (at: number) => byte(at) * 256 + byte(at + 1);
  const u32 = (at: number) => byte(at) * 16777216 + byte(at + 1) * 65536 + byte(at + 2) * 256 + byte(at + 3);
  const u24le = (at: number) => byte(at) + byte(at + 1) * 256 + byte(at + 2) * 65536;
  if (source.startsWith('data:image/png;')) return u32(16) * u32(20);
  if (source.startsWith('data:image/webp;')) {
    const chunk = binary.slice(12, 16);
    if (chunk === 'VP8X') return (u24le(24) + 1) * (u24le(27) + 1);
    if (chunk === 'VP8L') return (1 + byte(21) + ((byte(22) & 63) << 8)) * (1 + (byte(22) >> 6) + (byte(23) << 2) + ((byte(24) & 15) << 10));
    return ((byte(26) + byte(27) * 256) & 16383) * ((byte(28) + byte(29) * 256) & 16383);
  }
  let offset = 2;
  while (offset < binary.length) {
    if (byte(offset) !== 255) break;
    while (offset < binary.length && byte(offset) === 255) offset++;
    const marker = byte(offset++);
    if (marker === 1 || marker >= 208 && marker <= 215) continue;
    if (marker === 218 || marker === 217 || offset + 2 > binary.length) break;
    const length = u16(offset);
    if (length < 2 || offset + length > binary.length) break;
    if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker)) return u16(offset + 3) * u16(offset + 5);
    offset += length;
  }
  return fail('An embedded image has no usable dimensions.');
}

function colour(fill: FabricObject['fill']): string {
  if (fill === null || fill === '') return 'transparent';
  if (typeof fill !== 'string') return fail('Referenced paint needs raster preservation.');
  const color = new Color(fill);
  if (color.isUnrecognised || !color.getSource().every(Number.isFinite)) return fail('This SVG colour needs raster preservation.');
  return `#${color.toHexa().toLowerCase()}`;
}

function nativeElement(object: FabricObject, index: number): DesignElement | null {
  if (object.width <= 0 || object.height <= 0) return null;
  if (object.clipPath || object.shadow || object.stroke && object.stroke !== 'transparent') return fail('Clipped, shadowed or stroked objects need raster preservation.');
  const world = readObjectWorldTransform(object);
  const base = {
    id: uid(), name: `Imported layer ${index + 1}`, x: round(world.x), y: round(world.y), width: round(world.width), height: round(world.height),
    rotation: round(world.rotation), opacity: object.opacity, locked: false, visible: object.visible,
  };
  if (object instanceof FabricImage) {
    const image = object.getElement() as HTMLImageElement;
    if (object.cropX || object.cropY || Math.abs(object.width - image.naturalWidth) > 0.01 || Math.abs(object.height - image.naturalHeight) > 0.01 || object.filters.length || object.resizeFilter) fail('Cropped or filtered images need raster preservation.');
    return { ...base, type: 'image', name: `Imported image ${index + 1}`, src: validateImageSource(object.getSrc()) };
  }
  if (object instanceof FabricText) {
    if (object.fontStyle !== 'normal' || object.underline || object.overline || object.linethrough || Math.abs(world.scaleX - world.scaleY) > 0.00001 || object.text.includes('\n')) fail('Styled or stretched text needs raster preservation.');
    const font = DESIGN_FONTS.find(font => font.toLowerCase() === object.fontFamily.toLowerCase());
    const weight = ['normal', '400', 400].includes(object.fontWeight) ? 400 : ['bold', '700', 700].includes(object.fontWeight) ? 700 : null;
    if (!font || !weight) return fail('This font needs raster preservation.');
    const fontSize = round(object.fontSize * world.scaleY), letterSpacing = round(object.charSpacing * object.fontSize / 1000 * world.scaleX);
    if (fontSize < 6 || fontSize > 512 || letterSpacing < -10 || letterSpacing > 100) return fail('The SVG text size or spacing needs raster preservation.');
    // Textbox includes word-wrap thresholds that FabricText's intrinsic width
    // can miss by a fraction after scaling/serialization. Preserve the original
    // left/top and angle, adding only nonpainting space to the right of the line.
    let width = round(world.width + Math.max(1, world.width * 0.005));
    const probe = new Textbox(object.text, { width, fontSize, fontFamily: font, fontWeight: weight, charSpacing: letterSpacing / fontSize * 1000, lineHeight: 1.12, strokeWidth: 0, textAlign: 'left', splitByGrapheme: false });
    try {
      for (let attempt = 0; probe.textLines.length > 1 && attempt < 4; attempt++) {
        width = round(width + Math.max(2, width * 0.01)); probe.set('width', width); probe.initDimensions();
      }
      if (probe.textLines.length > 1) return fail('The original text line needs raster preservation.');
      width = Math.max(width, probe.width);
    } finally { probe.dispose(); }
    return { ...base, width, type: 'text', name: cleanName(object.text, `Imported text ${index + 1}`), text: object.text, fill: colour(object.fill), fontFamily: font, fontWeight: weight, fontSize, textAlign: 'left', letterSpacing };
  }
  if (object instanceof Rect) {
    const rx = object.rx * world.scaleX, ry = object.ry * world.scaleY;
    if (Math.abs(rx - ry) > 0.01) fail('Elliptical corners need raster preservation.');
    return { ...base, type: 'rect', name: `Imported rectangle ${index + 1}`, fill: colour(object.fill), borderRadius: round(rx) };
  }
  if (object instanceof Ellipse || object instanceof Circle) return { ...base, type: 'ellipse', name: `Imported ellipse ${index + 1}`, fill: colour(object.fill) };
  return fail('This SVG geometry needs raster preservation.');
}

function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('The imported artwork could not be stored.'));
    reader.onerror = () => reject(new Error('The imported artwork could not be stored.'));
    reader.onabort = () => reject(new Error('Import was cancelled.'));
    reader.readAsDataURL(blob);
  });
}

async function rasterPage(svg: SanitizedSvg, name: string): Promise<DesignPage> {
  const rasterRoot = svg.root.cloneNode(true) as Element;
  // CSS must not override the bounded raster viewport's intrinsic dimensions.
  rasterRoot.setAttribute('style', `${rasterRoot.getAttribute('style') ?? ''};width:${svg.width}px !important;height:${svg.height}px !important`);
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(rasterRoot)], { type: 'image/svg+xml' }));
  let image: HTMLImageElement | undefined;
  const canvas = document.createElement('canvas'); canvas.width = svg.width; canvas.height = svg.height;
  try {
    image = await decode(url);
    const context = canvas.getContext('2d');
    if (!context) return fail('The browser could not create an SVG import canvas.');
    context.drawImage(image, 0, 0, svg.width, svg.height);
    const encode = (type: string, quality?: number): Promise<Blob> => new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('The SVG artwork could not be encoded.')), type, quality));
    let blob = await encode('image/png');
    if (blob.size > DESIGN_MAX_IMAGE_BYTES) {
      blob = await encode('image/webp', 0.92);
      if (blob.type !== 'image/webp' || blob.size > DESIGN_MAX_IMAGE_BYTES) fail('The flattened SVG exceeds 10 MB. Export a smaller page or simplify its images.');
      svg.warnings.add('The flattened artwork uses high-quality WebP compression to stay within the 10 MB image limit.');
    }
    const src = validateImageSource(await toDataUrl(blob));
    return { id: uid(), name, background: '#ffffff', elements: [{ id: uid(), name: 'Imported SVG artwork (flattened)', type: 'image', src, x: 0, y: 0, width: svg.width, height: svg.height, rotation: 0, opacity: 1, locked: false, visible: true }] };
  } finally { URL.revokeObjectURL(url); image?.removeAttribute('src'); canvas.width = 0; canvas.height = 0; }
}

/** Import one self-contained local Canva SVG; no fetch or source URL is retained. */
export async function importCanvaSvg(file: File): Promise<CanvaPageSet> {
  if (!file.size || file.size > MAX_FILE_BYTES) fail('Choose an SVG file under 10 MB.');
  if (file.type && !['image/svg+xml', 'text/xml', 'application/xml', 'text/plain', 'application/octet-stream'].includes(file.type.toLowerCase())) fail('Choose a Canva SVG export.');
  const title = cleanName(file.name.replace(/\.svg$/i, ''), 'Imported Canva SVG');
  const svg = sanitize(await file.text());
  let declaredPixels = 0;
  for (const [source, instances] of svg.images) {
    declaredPixels += declaredImagePixels(source) * instances;
    if (!Number.isFinite(declaredPixels) || declaredPixels > MAX_IMAGE_PIXELS_TOTAL) fail('The SVG exceeds the 64-megapixel budget for embedded and repeated image resources. Reduce image resolution first.');
  }
  let decodedPixels = 0;
  for (const [source, instances] of svg.images) {
    const image = await decode(source);
    decodedPixels += image.naturalWidth * image.naturalHeight * instances; image.removeAttribute('src');
    if (decodedPixels > MAX_IMAGE_PIXELS_TOTAL) fail('The SVG contains too many large or repeated images. Reduce their resolution before importing.');
  }
  let page: DesignPage | null = null;
  if (!svg.reasons.size) {
    const graphicNodes = Array.from(svg.root.querySelectorAll('*')).filter(element => drawableTags.has(element.localName.toLowerCase()));
    if (graphicNodes.length > DESIGN_MAX_ELEMENTS) svg.reasons.add('more than 150 editable layers');
    else {
      // No actual strokes exist on this simple path. Fabric otherwise reserves
      // its default one-pixel stroke in object geometry even for SVG stroke:none.
      graphicNodes.forEach(element => { element.setAttribute('stroke-width', '0'); if (element.hasAttribute('style')) element.setAttribute('style', `${element.getAttribute('style')};stroke-width:0`); });
      const controller = new AbortController(), timer = window.setTimeout(() => controller.abort(), 15000);
      let objects: Array<FabricObject | null> = [];
      const created = new Set<FabricObject>();
      try {
        const parsed = await loadSVGFromString(new XMLSerializer().serializeToString(svg.root), (_element, object) => { created.add(object); }, { signal: controller.signal });
        objects = parsed.objects;
        if (objects.some(object => !object) || objects.length > DESIGN_MAX_ELEMENTS) fail('Some SVG layers could not be converted.');
        const elements = objects.flatMap((object, index) => { const element = object && nativeElement(object, index); return element ? [element] : []; });
        page = { id: uid(), name: title, background: '#ffffff', elements };
        validateDesignDocument({ format: 'open-design-studio', version: 1, width: svg.width, height: svg.height, pages: [page] });
        if (elements.some(element => element.type === 'text')) svg.warnings.add('Simple text was imported as editable text. Review line spacing and font metrics against the Canva export.');
      } catch {
        page = null; svg.reasons.add('geometry, paint or text outside the editable format');
      } finally { window.clearTimeout(timer); objects.forEach(object => { if (object) created.add(object); }); created.forEach(object => object.dispose()); }
    }
  }
  if (!page) {
    page = await rasterPage(svg, title);
    svg.warnings.add(`Imported as one image to preserve ${[...svg.reasons].join(', ') || 'complex SVG artwork'}. Its internal shapes and text are not editable.`);
    if (svg.reasons.has('paths or outlined artwork')) svg.warnings.add('SVG paths may contain text converted to outlines. Outlined text cannot be recovered as editable text.');
  }
  const validated = validateDesignDocument({ format: 'open-design-studio', version: 1, width: svg.width, height: svg.height, pages: [page] });
  return { title, width: validated.width, height: validated.height, pages: validated.pages, warnings: [...svg.warnings] };
}
