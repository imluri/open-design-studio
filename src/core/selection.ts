import { ActiveSelection, Point } from 'fabric';
import type { Canvas, FabricObject, Textbox } from 'fabric';
import type { LayerObject } from './canvas';
import type { DesignPage } from './model';

export interface MarqueeBox { left: number; top: number; width: number; height: number }
interface SelectionOptions {
  getPage: () => DesignPage;
  isBlocked: () => boolean;
  onSelection: (ids: string[]) => void;
}
interface SelectionController { getPage: () => DesignPage; applying: boolean }
const controllers = new WeakMap<Canvas, SelectionController>();
const isActiveSelection = (object: FabricObject | undefined): object is ActiveSelection => object instanceof ActiveSelection;
const available = (object: FabricObject) => object.visible && object.opacity > 0 && object.selectable && !object.lockMovementX && !object.lockMovementY;
const sameIds = (left: readonly string[], right: readonly string[]) => left.length === right.length && left.every((id, index) => id === right[index]);
const objectId = (object: FabricObject): string | undefined => (object as LayerObject).studioId;
const alive = (canvas: Canvas) => !canvas.disposed && !canvas.destroyed;

/** IDs follow the document's canvas stack, independently of selection order. */
export function getSelectionIds(canvas: Canvas): string[] {
  if (!alive(canvas)) return [];
  const selected = new Set(canvas.getActiveObjects());
  return canvas.getObjects().filter(object => selected.has(object)).flatMap(object => {
    const id = objectId(object);
    return id ? [id] : [];
  });
}

/** Logical groups are flat metadata. Only complete visible, unlocked units move. */
export function expandSelectionIds(page: DesignPage, ids: readonly string[]): string[] {
  const seeds = new Set(ids);
  const lockedGroups = new Set(page.elements.filter(element => (element.locked || !element.visible || element.opacity <= 0) && element.groupId).map(element => element.groupId));
  const movable = (element: DesignPage['elements'][number]) => element.visible && element.opacity > 0 && !element.locked && !(element.groupId && lockedGroups.has(element.groupId));
  const groups = new Set(page.elements.filter(element => seeds.has(element.id) && movable(element) && element.groupId).map(element => element.groupId));
  return page.elements.filter(element => movable(element) && (seeds.has(element.id) || Boolean(element.groupId && groups.has(element.groupId)))).map(element => element.id);
}

function configureSelection(selection: ActiveSelection): void {
  selection.set({
    lockScalingFlip: true, lockSkewingX: true, lockSkewingY: true,
    cornerColor: '#555555', borderColor: '#555555', cornerStrokeColor: '#ffffff',
    transparentCorners: false, cornerStyle: 'circle', multiSelectionStacking: 'canvas-stacking',
  });
  selection.setControlsVisibility({ ml: false, mr: false, mt: false, mb: false });
  selection.setCoords();
}

/**
 * Replace only the transient Fabric selection. Deselecting its wrapper first
 * restores every child's scene transform before a new wrapper is constructed.
 */
export function applySelection(canvas: Canvas, ids: readonly string[]): string[] {
  if (!alive(canvas)) return [];
  const controller = controllers.get(canvas);
  const wanted = new Set(controller ? expandSelectionIds(controller.getPage(), ids) : ids);
  const objects = canvas.getObjects().filter(object => {
    const id = objectId(object);
    return id && wanted.has(id) && available(object);
  });
  const nextIds = objects.map(object => objectId(object)!);
  if (sameIds(getSelectionIds(canvas), nextIds)) {
    const active = canvas.getActiveObject();
    if (isActiveSelection(active)) configureSelection(active);
    return nextIds;
  }
  const wasApplying = controller?.applying ?? false;
  if (controller) controller.applying = true;
  try {
    // ActiveSelection.dispose() would dispose live children. onDeselect() instead
    // removes its members and preserves their original canvas ownership.
    canvas.discardActiveObject();
    if (objects.length === 1) canvas.setActiveObject(objects[0]);
    else if (objects.length > 1) {
      const selection = new ActiveSelection(objects, { canvas, multiSelectionStacking: 'canvas-stacking' });
      configureSelection(selection);
      canvas.setActiveObject(selection);
    }
    objects.forEach(object => object.setCoords());
    canvas.requestRenderAll();
    return getSelectionIds(canvas);
  } finally {
    if (controller) controller.applying = wasApplying;
  }
}

function pointerCoordinates(canvas: Canvas, clientX: number, clientY: number): { viewport: Point; scene: Point } | null {
  const bounds = canvas.upperCanvasEl.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return null;
  const viewport = new Point((clientX - bounds.left) * canvas.width / bounds.width, (clientY - bounds.top) * canvas.height / bounds.height);
  const [a, b, c, d, e, f] = canvas.viewportTransform;
  const determinant = a * d - b * c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-10) return null;
  return { viewport, scene: new Point((d * (viewport.x - e) - c * (viewport.y - f)) / determinant, (-b * (viewport.x - e) + a * (viewport.y - f)) / determinant) };
}

/** Native selection/box controls, normalized to whole logical groups. */
export function attachMultiSelection(canvas: Canvas, options: SelectionOptions): () => void {
  let disposed = false;
  let shiftBox: string[] | null = null;
  const controller: SelectionController = { getPage: options.getPage, applying: false };
  controllers.set(canvas, controller);
  const previous = { selection: canvas.selection, selectionKey: canvas.selectionKey, uniformScaling: canvas.uniformScaling, uniScaleKey: canvas.uniScaleKey };
  canvas.selection = true;
  canvas.selectionKey = 'shiftKey';
  // Fabric otherwise reverses uniform scaling while Shift is held. The portable
  // document supports neither skew nor reflection, including within a selection.
  canvas.uniformScaling = true;
  canvas.uniScaleKey = undefined;
  const surface = canvas.upperCanvasEl, ownerDocument = surface.ownerDocument, ownerWindow = ownerDocument.defaultView;
  const notify = (ids: string[]) => { if (!disposed && alive(canvas)) options.onSelection(ids); };
  const normalize = () => {
    if (disposed || controller.applying || !alive(canvas) || options.isBlocked()) return;
    const current = getSelectionIds(canvas);
    const ids = expandSelectionIds(options.getPage(), current);
    notify(applySelection(canvas, ids));
  };
  const resetGesture = () => { shiftBox = null; };
  const beforeDown = (event: MouseEvent | PointerEvent | TouchEvent) => {
    resetGesture();
    if (event.defaultPrevented || disposed || !alive(canvas) || options.isBlocked() || canvas.skipTargetFind || canvas.isDrawingMode) return;
    if ('button' in event && event.button !== 0) return;
    if ('isPrimary' in event && !event.isPrimary) return;
    if ('touches' in event && event.touches.length !== 1) return;
    const active = canvas.getActiveObject();
    if ((active as Textbox | undefined)?.isEditing) return;
    const contact = 'touches' in event ? event.touches[0] : event;
    const point = pointerCoordinates(canvas, contact.clientX, contact.clientY);
    if (!point || active?.findControl(point.viewport, 'touches' in event)) return;
    // Public hit testing avoids findTarget's event cache. This capture listener
    // runs before Fabric caches the original leaf for its mouse/touch handler.
    const objects = canvas.getObjects().filter(available);
    objects.forEach(object => object.setCoords());
    const hit = canvas.searchPossibleTargets(objects, point.scene).target;
    const id = hit && objectId(hit);
    const initial = getSelectionIds(canvas);
    if (event.shiftKey && id) {
      const unit = expandSelectionIds(options.getPage(), [id]);
      const members = new Set(unit);
      const removing = initial.some(selected => members.has(selected));
      const ids = removing ? initial.filter(selected => !members.has(selected)) : [...initial, ...unit];
      notify(applySelection(canvas, ids));
      // Toggle once, without native Fabric then toggling the same leaf again.
      event.preventDefault(); event.stopImmediatePropagation();
      return;
    }
    const overSelection = isActiveSelection(active) && Boolean(canvas.searchPossibleTargets([active], point.scene).target);
    if (event.shiftKey && !id && !overSelection) { shiftBox = initial; return; }
    if (event.shiftKey || !id || overSelection || initial.includes(id)) return;
    const element = options.getPage().elements.find(item => item.id === id);
    if (element?.groupId) notify(applySelection(canvas, expandSelectionIds(options.getPage(), [id])));
  };
  const mouseUp = () => {
    if (disposed || !alive(canvas)) return;
    const initial = shiftBox; resetGesture();
    if (options.isBlocked()) return;
    if (initial) notify(applySelection(canvas, expandSelectionIds(options.getPage(), [...initial, ...getSelectionIds(canvas)])));
    else normalize();
  };
  const removers = [
    canvas.on('selection:created', normalize), canvas.on('selection:updated', normalize), canvas.on('selection:cleared', normalize),
    canvas.on('mouse:up', mouseUp), canvas.on('canvas:cleared', resetGesture),
  ];
  const pointerDown = (event: PointerEvent) => beforeDown(event);
  const mouseDown = (event: MouseEvent) => beforeDown(event);
  const touchStart = (event: TouchEvent) => beforeDown(event);
  if (canvas.enablePointerEvents) surface.addEventListener('pointerdown', pointerDown, true);
  else { surface.addEventListener('mousedown', mouseDown, true); surface.addEventListener('touchstart', touchStart, { capture: true, passive: false }); }
  const hidden = () => { if (ownerDocument.hidden) resetGesture(); };
  ownerWindow?.addEventListener('blur', resetGesture);
  ownerWindow?.addEventListener('pointercancel', resetGesture, true);
  ownerDocument.addEventListener('visibilitychange', hidden);
  const active = canvas.getActiveObject();
  if (isActiveSelection(active)) configureSelection(active);
  return () => {
    if (disposed) return;
    disposed = true; resetGesture(); removers.forEach(remove => remove());
    surface.removeEventListener('pointerdown', pointerDown, true);
    surface.removeEventListener('mousedown', mouseDown, true);
    surface.removeEventListener('touchstart', touchStart, true);
    ownerWindow?.removeEventListener('blur', resetGesture);
    ownerWindow?.removeEventListener('pointercancel', resetGesture, true);
    ownerDocument.removeEventListener('visibilitychange', hidden);
    if (controllers.get(canvas) === controller) {
      controllers.delete(canvas);
      if (alive(canvas)) Object.assign(canvas, previous);
    }
  };
}

/** Outside-paper marquee. Its rectangle is UI state and never a Fabric object. */
export function attachStageMarquee(stage: HTMLDivElement, canvas: Canvas, options: SelectionOptions & { onMarquee: (box: MarqueeBox | null) => void }): () => void {
  let disposed = false;
  let gesture: { pointerId: number; x: number; y: number; endX: number; endY: number; initial: string[]; shift: boolean } | null = null;
  const ownerDocument = stage.ownerDocument, ownerWindow = ownerDocument.defaultView;
  const clear = () => {
    const previous = gesture; gesture = null;
    if (previous) {
      try { if (stage.hasPointerCapture(previous.pointerId)) stage.releasePointerCapture(previous.pointerId); } catch { /* A cancelled pointer may already be released. */ }
      if (!disposed) options.onMarquee(null);
    }
  };
  const down = (event: PointerEvent) => {
    if (disposed || gesture || event.target !== stage || event.button !== 0 || !event.isPrimary || !alive(canvas) || options.isBlocked()) return;
    gesture = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, endX: event.clientX, endY: event.clientY, initial: getSelectionIds(canvas), shift: event.shiftKey };
    try { stage.setPointerCapture(event.pointerId); } catch { /* Window listeners also cover browsers without capture. */ }
    stage.focus({ preventScroll: true });
    event.preventDefault(); event.stopImmediatePropagation();
  };
  const move = (event: PointerEvent) => {
    const current = gesture;
    if (!current || current.pointerId !== event.pointerId || disposed) return;
    if (!alive(canvas) || options.isBlocked()) { clear(); return; }
    current.endX = event.clientX; current.endY = event.clientY;
    if (Math.hypot(current.endX - current.x, current.endY - current.y) < 3) return;
    const bounds = stage.getBoundingClientRect();
    options.onMarquee({
      left: Math.min(current.x, current.endX) - bounds.left - stage.clientLeft + stage.scrollLeft,
      top: Math.min(current.y, current.endY) - bounds.top - stage.clientTop + stage.scrollTop,
      width: Math.abs(current.endX - current.x), height: Math.abs(current.endY - current.y),
    });
    event.preventDefault();
  };
  const up = (event: PointerEvent) => {
    const current = gesture;
    if (!current || current.pointerId !== event.pointerId || disposed) return;
    current.endX = event.clientX; current.endY = event.clientY;
    clear();
    if (!alive(canvas) || options.isBlocked()) return;
    let picked: string[] = [];
    if (Math.hypot(current.endX - current.x, current.endY - current.y) >= 3) {
      const start = pointerCoordinates(canvas, current.x, current.y)?.scene;
      const end = pointerCoordinates(canvas, current.endX, current.endY)?.scene;
      if (!start || !end) return;
      const topLeft = new Point(Math.min(start.x, end.x), Math.min(start.y, end.y));
      const bottomRight = new Point(Math.max(start.x, end.x), Math.max(start.y, end.y));
      const page = options.getPage();
      const allowed = new Set(expandSelectionIds(page, page.elements.map(element => element.id)));
      picked = canvas.getObjects().filter(object => {
        const id = objectId(object);
        if (!id || !allowed.has(id) || !available(object)) return false;
        object.setCoords();
        return object.intersectsWithRect(topLeft, bottomRight) || object.isContainedWithinRect(topLeft, bottomRight) || object.containsPoint(topLeft.midPointFrom(bottomRight));
      }).map(object => objectId(object)!);
    }
    const ids = expandSelectionIds(options.getPage(), current.shift ? [...current.initial, ...picked] : picked);
    options.onSelection(applySelection(canvas, ids));
    event.preventDefault();
  };
  const cancelPointer = (event: PointerEvent) => { if (gesture?.pointerId === event.pointerId) clear(); };
  const keyDown = (event: KeyboardEvent) => { if (gesture && event.key === 'Escape') { clear(); event.preventDefault(); event.stopPropagation(); } };
  const hidden = () => { if (ownerDocument.hidden) clear(); };
  stage.addEventListener('pointerdown', down, true);
  stage.addEventListener('lostpointercapture', cancelPointer);
  ownerWindow?.addEventListener('pointermove', move, { capture: true, passive: false });
  ownerWindow?.addEventListener('pointerup', up, true);
  ownerWindow?.addEventListener('pointercancel', cancelPointer, true);
  ownerWindow?.addEventListener('keydown', keyDown, true);
  ownerWindow?.addEventListener('blur', clear);
  ownerDocument.addEventListener('visibilitychange', hidden);
  return () => {
    if (disposed) return;
    clear(); disposed = true;
    stage.removeEventListener('pointerdown', down, true);
    stage.removeEventListener('lostpointercapture', cancelPointer);
    ownerWindow?.removeEventListener('pointermove', move, true);
    ownerWindow?.removeEventListener('pointerup', up, true);
    ownerWindow?.removeEventListener('pointercancel', cancelPointer, true);
    ownerWindow?.removeEventListener('keydown', keyDown, true);
    ownerWindow?.removeEventListener('blur', clear);
    ownerDocument.removeEventListener('visibilitychange', hidden);
  };
}
