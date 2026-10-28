import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import type { Canvas } from 'fabric';

interface ViewportOptions {
  stage: RefObject<HTMLDivElement | null>;
  canvas: RefObject<Canvas | null>;
  ready: boolean;
  width: number;
  height: number;
  pageId: string;
  disabled: boolean;
}

interface ViewportState {
  scale: number;
  zoom: string;
  centerX: number;
  centerY: number;
  panX: number;
  panY: number;
}

interface PanGesture { pointerId: number; pointerType: string; x: number; y: number }
interface CanvasNavigationState {
  instance: Canvas;
  selection: boolean;
  skipTargetFind: boolean;
  defaultCursor: string;
  hoverCursor: string;
  moveCursor: string;
  upperCursor: string;
}

const MIN_SCALE = 0.02;
const MAX_SCALE = 4;
const CONTROL_SELECTOR = 'button,a,input,textarea,select,summary,[role="button"],[role="tab"],[role="menu"],[role="dialog"],[contenteditable="true"],[contenteditable=""],.editor-context,.canvas-loading';
const TYPING_SELECTOR = 'input,textarea,select,[contenteditable="true"],[contenteditable=""],[role="textbox"]';
const clampScale = (value: number) => Math.max(MIN_SCALE, Math.min(MAX_SCALE, value));
const percentage = (scale: number) => String(Number((scale * 100).toFixed(1)));
const targetElement = (target: EventTarget | null) => target instanceof Element ? target : null;

/** View navigation changes CSS presentation only. Artwork coordinates and history stay untouched. */
export default function useCanvasViewport(options: ViewportOptions) {
  const latest = useRef(options); latest.current = options;
  const [viewport, setViewport] = useState<ViewportState>({ scale: 0.4, zoom: 'fit', centerX: 0, centerY: 0, panX: 0, panY: 0 });
  const view = useRef(viewport);
  const [handTool, setHandToolState] = useState(false);
  const hand = useRef(false);
  const [panning, setPanning] = useState(false);
  const drag = useRef<PanGesture | null>(null);
  const editingPointer = useRef<number | null>(null);
  const suppressMouseUp = useRef(false);
  const suppressTouchEnd = useRef(false);
  const space = useRef(false);
  const hovering = useRef(false);
  const navigation = useRef<CanvasNavigationState | null>(null);
  const stageCursor = useRef<{ element: HTMLDivElement; cursor: string; touchAction: string } | null>(null);
  const offsetFrame = useRef(0);

  const updateView = useCallback((next: ViewportState) => {
    const previous = view.current;
    if (Object.keys(next).every(key => next[key as keyof ViewportState] === previous[key as keyof ViewportState])) return;
    view.current = next;
    setViewport(next);
  }, []);

  const isTextEditing = useCallback(() => {
    const active = latest.current.canvas.current?.getActiveObject() as { isEditing?: boolean } | undefined;
    return Boolean(active?.isEditing);
  }, []);

  const syncNavigation = useCallback(() => {
    const { canvas, stage, ready, disabled } = latest.current;
    const instance = ready ? canvas.current : null;
    const navigating = !disabled && Boolean((hand.current && editingPointer.current === null) || space.current || drag.current);
    const saved = navigation.current;
    if (saved && (saved.instance !== instance || !navigating)) {
      if (!saved.instance.disposed && !saved.instance.destroyed) {
        Object.assign(saved.instance, {
          selection: saved.selection, skipTargetFind: saved.skipTargetFind,
          defaultCursor: saved.defaultCursor, hoverCursor: saved.hoverCursor, moveCursor: saved.moveCursor,
        });
        saved.instance.upperCanvasEl.style.cursor = saved.upperCursor;
      }
      navigation.current = null;
    }
    if (navigating && instance && !instance.disposed && !instance.destroyed) {
      if (!navigation.current) navigation.current = {
        instance, selection: instance.selection, skipTargetFind: instance.skipTargetFind,
        defaultCursor: instance.defaultCursor, hoverCursor: instance.hoverCursor, moveCursor: instance.moveCursor,
        upperCursor: instance.upperCanvasEl.style.cursor,
      };
      const cursor = drag.current ? 'grabbing' : 'grab';
      instance.selection = false;
      instance.skipTargetFind = true;
      instance.defaultCursor = cursor;
      instance.hoverCursor = cursor;
      instance.moveCursor = cursor;
      instance.upperCanvasEl.style.cursor = cursor;
    }
    const element = stage.current;
    if (stageCursor.current && (stageCursor.current.element !== element || !navigating)) {
      stageCursor.current.element.style.cursor = stageCursor.current.cursor;
      stageCursor.current.element.style.touchAction = stageCursor.current.touchAction;
      stageCursor.current = null;
    }
    if (navigating && element) {
      if (!stageCursor.current) stageCursor.current = { element, cursor: element.style.cursor, touchAction: element.style.touchAction };
      element.style.cursor = drag.current ? 'grabbing' : 'grab';
      element.style.touchAction = 'none';
    }
  }, []);

  const applyCanvasSize = useCallback(() => {
    const { canvas, ready, width, height } = latest.current;
    const instance = ready ? canvas.current : null;
    if (!instance || instance.disposed || instance.destroyed) return;
    instance.setDimensions({ width: `${width * view.current.scale}px`, height: `${height * view.current.scale}px` }, { cssOnly: true });
    instance.calcOffset();
    const active = instance.getActiveObject() as { isEditing?: boolean; updateTextareaPosition?: () => void } | undefined;
    if (active?.isEditing) active.updateTextareaPosition?.();
    instance.requestRenderAll();
  }, []);

  // This is also called after Fabric rebuilds a page, which resets its CSS dimensions.
  const refreshLayout = useCallback(() => {
    const { stage, width, height } = latest.current;
    const element = stage.current;
    if (!element) return;
    const styles = window.getComputedStyle(element);
    const left = parseFloat(styles.paddingLeft) || 0, right = parseFloat(styles.paddingRight) || 0;
    const top = parseFloat(styles.paddingTop) || 0, bottom = parseFloat(styles.paddingBottom) || 0;
    const availableWidth = Math.max(1, element.clientWidth - left - right);
    const availableHeight = Math.max(1, element.clientHeight - top - bottom);
    const previous = view.current;
    updateView({
      ...previous,
      centerX: left + availableWidth / 2,
      centerY: top + availableHeight / 2,
      scale: previous.zoom === 'fit' ? clampScale(Math.min(availableWidth / Math.max(1, width), availableHeight / Math.max(1, height), 1)) : previous.scale,
    });
    applyCanvasSize();
    window.cancelAnimationFrame(offsetFrame.current);
    offsetFrame.current = window.requestAnimationFrame(() => {
      applyCanvasSize();
      syncNavigation();
    });
  }, [applyCanvasSize, syncNavigation, updateView]);

  const zoomAt = useCallback((requestedScale: number, point?: { x: number; y: number }) => {
    if (latest.current.disabled || !Number.isFinite(requestedScale)) return;
    const previous = view.current;
    const nextScale = clampScale(requestedScale);
    const x = point?.x ?? previous.centerX, y = point?.y ?? previous.centerY;
    const ratio = nextScale / previous.scale;
    updateView({
      ...previous, scale: nextScale, zoom: percentage(nextScale),
      panX: x - previous.centerX - (x - previous.centerX - previous.panX) * ratio,
      panY: y - previous.centerY - (y - previous.centerY - previous.panY) * ratio,
    });
  }, [updateView]);

  const fit = useCallback(() => {
    if (latest.current.disabled) return;
    updateView({ ...view.current, zoom: 'fit', panX: 0, panY: 0 });
    refreshLayout();
  }, [refreshLayout, updateView]);

  const actualSize = useCallback(() => {
    if (latest.current.disabled) return;
    updateView({ ...view.current, zoom: '100', scale: 1, panX: 0, panY: 0 });
  }, [updateView]);

  const setZoom = useCallback((value: string) => {
    if (value === 'fit') fit();
    else if (value.trim()) zoomAt(Number(value) / 100);
  }, [fit, zoomAt]);
  const zoomIn = useCallback(() => zoomAt(view.current.scale * 1.2), [zoomAt]);
  const zoomOut = useCallback(() => zoomAt(view.current.scale / 1.2), [zoomAt]);
  const setHandTool = useCallback((value: boolean) => {
    hand.current = value;
    setHandToolState(value);
    syncNavigation();
  }, [syncNavigation]);
  const isInteracting = useCallback(() => Boolean(drag.current || editingPointer.current !== null), []);

  const endPan = useCallback(() => {
    const gesture = drag.current;
    drag.current = null;
    if (gesture) {
      setPanning(false);
      const element = latest.current.stage.current;
      if (element?.hasPointerCapture(gesture.pointerId)) element.releasePointerCapture(gesture.pointerId);
    }
    syncNavigation();
  }, [syncNavigation]);

  useLayoutEffect(() => {
    applyCanvasSize();
  }, [viewport, options.ready, options.width, options.height, applyCanvasSize]);

  useEffect(() => {
    const element = options.stage.current;
    if (!element) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(refreshLayout);
    });
    observer.observe(element);
    refreshLayout();
    return () => { observer.disconnect(); window.cancelAnimationFrame(frame); };
  }, [options.stage, options.ready, options.width, options.height, refreshLayout]);

  useEffect(() => {
    endPan();
    updateView({ ...view.current, zoom: 'fit', panX: 0, panY: 0 });
    refreshLayout();
  }, [options.pageId, endPan, refreshLayout, updateView]);

  useEffect(() => {
    if (options.disabled) { space.current = false; endPan(); }
    syncNavigation();
  }, [options.disabled, options.ready, handTool, endPan, syncNavigation]);

  useEffect(() => {
    const element = options.stage.current;
    if (!element) return;
    const blocked = (target: EventTarget | null) => Boolean(targetElement(target)?.closest(CONTROL_SELECTOR));
    const stop = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation(); };
    const localPoint = (event: { clientX: number; clientY: number }) => {
      const bounds = element.getBoundingClientRect();
      return { x: event.clientX - bounds.left - element.clientLeft, y: event.clientY - bounds.top - element.clientTop };
    };
    const wheel = (event: WheelEvent) => {
      if (latest.current.disabled || blocked(event.target)) return;
      stop(event);
      // Keep the coordinate system stable while an element or the viewport is
      // being dragged. The next wheel event works as soon as the drag finishes.
      if (drag.current || editingPointer.current !== null) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1;
      if (event.ctrlKey || event.metaKey) {
        const delta = Math.max(-600, Math.min(600, event.deltaY * unit));
        zoomAt(view.current.scale * Math.exp(-delta * 0.002), localPoint(event));
      } else {
        const previous = view.current;
        const horizontal = event.shiftKey && Math.abs(event.deltaX) < Math.abs(event.deltaY);
        updateView({ ...previous,
          panX: previous.panX - (horizontal ? event.deltaY : event.deltaX) * unit,
          panY: previous.panY - (horizontal ? 0 : event.deltaY) * unit,
        });
      }
    };
    const pointerDown = (event: PointerEvent) => {
      if (latest.current.disabled || blocked(event.target) || !latest.current.ready) return;
      if (!isTextEditing() && (event.button === 0 || event.button === 1)) element.focus({ preventScroll: true });
      if (drag.current) { if (drag.current.pointerType === 'touch') stop(event); return; }
      suppressMouseUp.current = false;
      suppressTouchEnd.current = false;
      // Plain left-drag belongs to selection, including outside the paper.
      const primaryPan = event.button === 0 && (hand.current || space.current);
      const middlePan = event.button === 1 && event.pointerType !== 'touch';
      if (!primaryPan && !middlePan) {
        if (event.button === 0) editingPointer.current = event.pointerId;
        return;
      }
      stop(event);
      drag.current = { pointerId: event.pointerId, pointerType: event.pointerType, x: event.clientX, y: event.clientY };
      suppressMouseUp.current = event.pointerType !== 'touch';
      suppressTouchEnd.current = event.pointerType === 'touch';
      setPanning(true);
      try { element.setPointerCapture(event.pointerId); } catch { /* Window listeners still finish the gesture. */ }
      syncNavigation();
    };
    const pointerMove = (event: PointerEvent) => {
      const gesture = drag.current;
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      stop(event);
      if (event.buttons === 0 && event.pointerType !== 'touch') { endPan(); return; }
      const previous = view.current;
      updateView({ ...previous, panX: previous.panX + event.clientX - gesture.x, panY: previous.panY + event.clientY - gesture.y });
      gesture.x = event.clientX; gesture.y = event.clientY;
    };
    const pointerUp = (event: PointerEvent) => {
      if (editingPointer.current === event.pointerId) {
        editingPointer.current = null;
        // Fabric still needs its compatibility mouseup to finish an element
        // transform before a newly selected Hand tool takes over targeting.
        window.cancelAnimationFrame(offsetFrame.current);
        offsetFrame.current = window.requestAnimationFrame(syncNavigation);
      }
      if (drag.current?.pointerId !== event.pointerId) return;
      stop(event);
      endPan();
    };
    // Fabric defaults to mouse/touch listeners. Suppress compatibility events as
    // well as pointer events so a viewport gesture cannot begin an object transform.
    const legacyMouse = (event: MouseEvent) => {
      if (event.type === 'mouseup' && suppressMouseUp.current) {
        suppressMouseUp.current = false;
        stop(event);
      } else if (drag.current || ((event.type === 'mousedown' || event.type === 'auxclick') && !latest.current.disabled && !blocked(event.target) && element.contains(event.target as Node) && (hand.current || space.current || event.button === 1))) stop(event);
    };
    const legacyTouch = (event: TouchEvent) => {
      if (event.type === 'touchend' && suppressTouchEnd.current) {
        if (event.touches.length === 0) suppressTouchEnd.current = false;
        stop(event);
      } else if (drag.current?.pointerType === 'touch') stop(event);
    };
    const lostCapture = (event: PointerEvent) => { if (event.pointerId === drag.current?.pointerId) endPan(); };
    const enter = () => { hovering.current = true; };
    const leave = () => { hovering.current = false; };
    const keyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || window.document.querySelector('dialog[open]')) return;
      try { if (window.document.querySelector(':popover-open')) return; } catch { /* Older browsers do not expose native popover state. */ }
      if (event.code !== 'Space' || event.ctrlKey || event.metaKey || event.altKey || latest.current.disabled || editingPointer.current !== null) return;
      const target = targetElement(event.target);
      if (target?.closest(TYPING_SELECTOR) || target?.closest(CONTROL_SELECTOR) || isTextEditing()) return;
      if (!hovering.current && !element.contains(window.document.activeElement)) return;
      stop(event);
      space.current = true;
      syncNavigation();
    };
    const keyUp = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || !space.current) return;
      space.current = false;
      // Releasing Space during a drag keeps that gesture active until pointerup.
      syncNavigation();
      if (!targetElement(event.target)?.closest(TYPING_SELECTOR)) stop(event);
    };
    const resetKeys = () => { space.current = false; hovering.current = false; editingPointer.current = null; suppressMouseUp.current = false; suppressTouchEnd.current = false; endPan(); };
    const focusChanged = (event: FocusEvent) => {
      if (space.current && (!element.contains(event.target as Node) || targetElement(event.target)?.closest(TYPING_SELECTOR))) {
        space.current = false; syncNavigation();
      }
    };
    const visibilityChanged = () => { if (window.document.hidden) resetKeys(); };
    element.addEventListener('wheel', wheel, { passive: false, capture: true });
    element.addEventListener('pointerdown', pointerDown, true);
    element.addEventListener('pointerenter', enter);
    element.addEventListener('pointerleave', leave);
    element.addEventListener('lostpointercapture', lostCapture);
    element.addEventListener('mousedown', legacyMouse, true);
    element.addEventListener('auxclick', legacyMouse, true);
    element.addEventListener('touchstart', legacyTouch, { passive: false, capture: true });
    window.addEventListener('pointermove', pointerMove, { passive: false, capture: true });
    window.addEventListener('pointerup', pointerUp, true);
    window.addEventListener('pointercancel', pointerUp, true);
    window.addEventListener('mousemove', legacyMouse, true);
    window.addEventListener('mouseup', legacyMouse, true);
    window.addEventListener('touchmove', legacyTouch, { passive: false, capture: true });
    window.addEventListener('touchend', legacyTouch, true);
    window.addEventListener('keydown', keyDown, true);
    window.addEventListener('keyup', keyUp, true);
    window.addEventListener('blur', resetKeys);
    window.document.addEventListener('focusin', focusChanged, true);
    window.document.addEventListener('visibilitychange', visibilityChanged);
    return () => {
      element.removeEventListener('wheel', wheel, true);
      element.removeEventListener('pointerdown', pointerDown, true);
      element.removeEventListener('pointerenter', enter);
      element.removeEventListener('pointerleave', leave);
      element.removeEventListener('lostpointercapture', lostCapture);
      element.removeEventListener('mousedown', legacyMouse, true);
      element.removeEventListener('auxclick', legacyMouse, true);
      element.removeEventListener('touchstart', legacyTouch, true);
      window.removeEventListener('pointermove', pointerMove, true);
      window.removeEventListener('pointerup', pointerUp, true);
      window.removeEventListener('pointercancel', pointerUp, true);
      window.removeEventListener('mousemove', legacyMouse, true);
      window.removeEventListener('mouseup', legacyMouse, true);
      window.removeEventListener('touchmove', legacyTouch, true);
      window.removeEventListener('touchend', legacyTouch, true);
      window.removeEventListener('keydown', keyDown, true);
      window.removeEventListener('keyup', keyUp, true);
      window.removeEventListener('blur', resetKeys);
      window.document.removeEventListener('focusin', focusChanged, true);
      window.document.removeEventListener('visibilitychange', visibilityChanged);
      resetKeys();
    };
  }, [options.stage, endPan, isTextEditing, syncNavigation, updateView, zoomAt]);

  useEffect(() => () => {
    window.cancelAnimationFrame(offsetFrame.current);
    hand.current = false;
    space.current = false;
    drag.current = null;
    syncNavigation();
  }, [syncNavigation]);

  const paperStyle: CSSProperties = {
    position: 'absolute',
    left: viewport.centerX + viewport.panX,
    top: viewport.centerY + viewport.panY,
    width: options.width * viewport.scale,
    height: options.height * viewport.scale,
    margin: 0,
    transform: 'translate(-50%, -50%)',
  };
  return { scale: viewport.scale, zoom: viewport.zoom, setZoom, zoomIn, zoomOut, fit, actualSize, handTool, setHandTool, panning, paperStyle, refreshLayout, isInteracting };
}
