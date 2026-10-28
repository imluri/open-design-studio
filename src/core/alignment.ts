import type { ActiveSelection, BasicTransformEvent, Canvas, FabricObject } from 'fabric';

export interface AlignmentBounds { left: number; top: number; width: number; height: number }
export type AlignmentKind = 'left' | 'centerX' | 'right' | 'top' | 'centerY' | 'bottom';
export interface AlignmentGuide { axis: 'x' | 'y'; position: number; start: number; end: number }

interface AlignmentOptions {
  isEnabled: () => boolean;
  isBlocked: () => boolean;
  getScale: () => number;
  getPageSize: () => { width: number; height: number };
  onGuides: (guides: AlignmentGuide[]) => void;
}
interface Reference { bounds: AlignmentBounds; page: boolean }

const validBounds = (bounds: AlignmentBounds) => [bounds.left, bounds.top, bounds.width, bounds.height].every(Number.isFinite) && bounds.width >= 0 && bounds.height >= 0;
const anchors = (bounds: AlignmentBounds, axis: 'x' | 'y') => axis === 'x'
  ? [bounds.left, bounds.left + bounds.width / 2, bounds.left + bounds.width]
  : [bounds.top, bounds.top + bounds.height / 2, bounds.top + bounds.height];

/** Refresh Fabric's coordinate cache before reading its rotated scene-space AABB. */
export function getObjectBounds(object: FabricObject): AlignmentBounds {
  object.setCoords();
  const { left, top, width, height } = object.getBoundingRect();
  return { left, top, width, height };
}

/** Pure offsets for the six explicit alignment actions. Bounds may be rotated AABBs. */
export function alignmentDelta(target: AlignmentBounds, reference: AlignmentBounds, kind: AlignmentKind): { x: number; y: number } {
  if (!validBounds(target) || !validBounds(reference)) return { x: 0, y: 0 };
  switch (kind) {
    case 'left': return { x: reference.left - target.left, y: 0 };
    case 'centerX': return { x: reference.left + reference.width / 2 - target.left - target.width / 2, y: 0 };
    case 'right': return { x: reference.left + reference.width - target.left - target.width, y: 0 };
    case 'top': return { x: 0, y: reference.top - target.top };
    case 'centerY': return { x: 0, y: reference.top + reference.height / 2 - target.top - target.height / 2 };
    case 'bottom': return { x: 0, y: reference.top + reference.height - target.top - target.height };
  }
}

/**
 * Guides live outside the document. Only the existing Fabric drag is adjusted,
 * so the workspace's normal object:modified handler owns the single undo entry.
 */
export function attachAlignmentGuides(canvas: Canvas, options: AlignmentOptions): () => void {
  let disposed = false;
  let cancelled = false;
  let currentTarget: FabricObject | null = null;
  let references: Reference[] = [];
  let shown: AlignmentGuide[] = [];

  const publish = (guides: AlignmentGuide[]) => {
    if (disposed || canvas.disposed || canvas.destroyed) return;
    if (shown.length === guides.length && shown.every((guide, index) => {
      const next = guides[index];
      return guide.axis === next.axis && guide.position === next.position && guide.start === next.start && guide.end === next.end;
    })) return;
    shown = guides;
    options.onGuides(guides);
  };
  const clear = () => { currentTarget = null; references = []; publish([]); };

  const prepare = (target: FabricObject) => {
    currentTarget = target;
    const page = options.getPageSize();
    const pageValid = Number.isFinite(page.width) && Number.isFinite(page.height) && page.width > 0 && page.height > 0;
    const members = new Set(target.isType('ActiveSelection') ? (target as ActiveSelection).getObjects() : [target]);
    references = [];
    for (const object of canvas.getObjects()) {
      if (object === target || members.has(object) || object.group === target || !object.visible || object.opacity <= 0) continue;
      const bounds = getObjectBounds(object);
      if (!validBounds(bounds)) continue;
      // A covering background repeats page anchors and otherwise attracts every
      // drag to its centre. Smaller containing cards still remain useful guides.
      if (pageValid && bounds.left <= 0.01 && bounds.top <= 0.01 && bounds.left + bounds.width >= page.width - 0.01 && bounds.top + bounds.height >= page.height - 0.01) continue;
      references.push({ bounds, page: false });
    }
    if (pageValid) references.push({ bounds: { left: 0, top: 0, width: page.width, height: page.height }, page: true });
  };

  const nearest = (bounds: AlignmentBounds, axis: 'x' | 'y', scale: number): number | null => {
    const tolerance = 6 / scale, tie = 0.01 / scale;
    const values = anchors(bounds, axis);
    let result: number | null = null, distance = Infinity, priority = -Infinity;
    for (const reference of references) {
      const referenceValues = anchors(reference.bounds, axis);
      for (let targetIndex = 0; targetIndex < values.length; targetIndex++) {
        for (let referenceIndex = 0; referenceIndex < referenceValues.length; referenceIndex++) {
          const delta = referenceValues[referenceIndex] - values[targetIndex], amount = Math.abs(delta);
          if (amount > tolerance) continue;
          const rank = (targetIndex === referenceIndex ? 4 : 0) + (targetIndex === 1 ? 1 : 0) + (reference.page ? 0 : 0.5);
          if (amount < distance - tie || (Math.abs(amount - distance) <= tie && rank > priority)) {
            result = delta; distance = amount; priority = rank;
          }
        }
      }
    }
    return result;
  };

  const matchingGuides = (bounds: AlignmentBounds, axis: 'x' | 'y', scale: number): AlignmentGuide[] => {
    const guides: AlignmentGuide[] = [], epsilon = 0.1 / scale, extension = 8 / scale;
    const crossAxis = axis === 'x' ? 'y' : 'x';
    const targetCross = anchors(bounds, crossAxis);
    for (const position of anchors(bounds, axis)) {
      let start = Infinity, end = -Infinity;
      for (const reference of references) {
        if (!anchors(reference.bounds, axis).some(value => Math.abs(value - position) <= epsilon)) continue;
        const referenceCross = anchors(reference.bounds, crossAxis);
        start = Math.min(start, targetCross[0], referenceCross[0]);
        end = Math.max(end, targetCross[2], referenceCross[2]);
      }
      if (!Number.isFinite(start)) continue;
      const existing = guides.find(guide => Math.abs(guide.position - position) <= epsilon);
      if (existing) { existing.start = Math.min(existing.start, start - extension); existing.end = Math.max(existing.end, end + extension); }
      else guides.push({ axis, position, start: start - extension, end: end + extension });
    }
    return guides;
  };

  const moving = (event: BasicTransformEvent & { target: FabricObject }) => {
    if (disposed || canvas.disposed || canvas.destroyed) return;
    const target = event.target;
    const alt = 'altKey' in event.e && event.e.altKey;
    // The ActiveSelection wrapper is a scene-root target. Its children still
    // have parent-relative coordinates and must never be corrected individually.
    if (cancelled || !options.isEnabled() || options.isBlocked() || alt || !target.visible || target.opacity <= 0 || !target.selectable || target.lockMovementX || target.lockMovementY || target.group) { clear(); return; }
    const scale = options.getScale();
    if (!Number.isFinite(scale) || scale <= 0) { clear(); return; }
    if (currentTarget !== target) prepare(target);
    const bounds = getObjectBounds(target);
    if (!validBounds(bounds)) { clear(); return; }
    const dx = nearest(bounds, 'x', scale), dy = nearest(bounds, 'y', scale);
    if (dx === null && dy === null) { publish([]); return; }
    if (dx || dy) {
      const center = target.getCenterPoint();
      center.x += dx ?? 0; center.y += dy ?? 0;
      target.setPositionByOrigin(center, 'center', 'center');
      target.setCoords();
      canvas.requestRenderAll();
    }
    const snapped = getObjectBounds(target);
    publish([
      ...(dx === null ? [] : matchingGuides(snapped, 'x', scale)),
      ...(dy === null ? [] : matchingGuides(snapped, 'y', scale)),
    ]);
  };

  const beginTransform = () => { cancelled = false; clear(); };
  const cancelTransform = () => { cancelled = true; clear(); };
  const removers = [
    canvas.on('object:moving', moving),
    canvas.on('before:transform', beginTransform),
    canvas.on('mouse:up', clear),
    canvas.on('selection:created', clear),
    canvas.on('selection:updated', clear),
    canvas.on('selection:cleared', clear),
    canvas.on('object:modified', clear),
    canvas.on('object:added', clear),
    canvas.on('object:removed', clear),
    canvas.on('canvas:cleared', clear),
    canvas.on('object:scaling', clear),
    canvas.on('object:rotating', clear),
  ];
  const surface = canvas.upperCanvasEl, ownerDocument = surface.ownerDocument, ownerWindow = ownerDocument.defaultView;
  const keyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') cancelTransform(); else if (event.key === 'Alt') clear(); };
  const visibility = () => { if (ownerDocument.hidden) cancelTransform(); };
  ownerWindow?.addEventListener('blur', cancelTransform);
  ownerDocument.addEventListener('keydown', keyDown, true);
  ownerDocument.addEventListener('visibilitychange', visibility);
  surface.addEventListener('pointercancel', cancelTransform);
  return () => {
    if (disposed) return;
    clear();
    disposed = true;
    removers.forEach(remove => remove());
    ownerWindow?.removeEventListener('blur', cancelTransform);
    ownerDocument.removeEventListener('keydown', keyDown, true);
    ownerDocument.removeEventListener('visibilitychange', visibility);
    surface.removeEventListener('pointercancel', cancelTransform);
  };
}
