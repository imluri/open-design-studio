import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { DesignDocument, DesignPage } from '../core/model';
import { DESIGN_MAX_PAGES } from '../core/model';
import { pageObjects } from '../core/canvas';
import './page-strip.css';

export interface PageStripProps {
  document: DesignDocument;
  pageIndex: number;
  canEdit: boolean;
  disabled: boolean;
  onSelect: (index: number) => void;
  onAdd: () => void;
  onDuplicate: (index: number) => void;
  onDelete: (index: number) => void;
  /** Both positions are final, zero-based page indexes. */
  onMove: (from: number, to: number) => void;
}

interface PreviewJob { cancelled: boolean; run: () => Promise<void> }
let previewRunning = false;
let previewQueue: PreviewJob[] = [];

/** One small renderer across filmstrip instances, including overlapping React mounts. */
function queuePreview(run: () => Promise<void>): () => void {
  const job = { cancelled: false, run };
  previewQueue.push(job);
  void drainPreviews();
  return () => { job.cancelled = true; previewQueue = previewQueue.filter(queued => queued !== job); };
}
async function drainPreviews() {
  if (previewRunning) return;
  previewRunning = true;
  try {
    let job: PreviewJob | undefined;
    while ((job = previewQueue.shift())) {
      if (job.cancelled) continue;
      // A thumbnail failure is displayed by its owner and must not stop later slides.
      try { await job.run(); } catch { /* The caller owns its error state. */ }
    }
  } finally { previewRunning = false; }
}

async function renderPreview(page: DesignPage, width: number, height: number, stale: () => boolean): Promise<Blob | null> {
  const { StaticCanvas } = await import('fabric');
  if (stale()) return null;
  const objects = await pageObjects(page, false);
  if (stale()) { for (const object of objects) object.dispose(); return null; }
  // The backing surface is at most 192 × 240, not a full-size slide export.
  const scale = Math.min(192 / width, 240 / height);
  const canvas = new StaticCanvas(undefined, {
    width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)),
    enableRetinaScaling: false, renderOnAddRemove: false,
    backgroundColor: page.background,
  });
  try {
    canvas.setViewportTransform([scale, 0, 0, scale, 0, 0]);
    canvas.add(...objects);
    if (stale()) return null;
    canvas.renderAll();
    const blob = await canvas.toBlob({ format: 'png', multiplier: 1, enableRetinaScaling: false });
    if (!blob) throw new Error('Preview unavailable');
    return stale() ? null : blob;
  } finally { await canvas.dispose(); }
}

function useNearFilmstrip(item: RefObject<HTMLLIElement | null>, root: RefObject<HTMLOListElement | null>) {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const target = item.current, scrollRoot = root.current;
    if (!target || !scrollRoot) return;
    if (typeof IntersectionObserver !== 'undefined') {
      const observer = new IntersectionObserver(entries => setNear(entries.some(entry => entry.isIntersecting)), { root: scrollRoot, rootMargin: '0px 144px', threshold: 0 });
      observer.observe(target);
      return () => observer.disconnect();
    }
    const update = () => {
      const bounds = target.getBoundingClientRect(), viewport = scrollRoot.getBoundingClientRect();
      setNear(bounds.right >= viewport.left - 144 && bounds.left <= viewport.right + 144);
    };
    update(); scrollRoot.addEventListener('scroll', update, { passive: true }); window.addEventListener('resize', update);
    return () => { scrollRoot.removeEventListener('scroll', update); window.removeEventListener('resize', update); };
  }, [item, root]);
  return near;
}

function usePreview(page: DesignPage, width: number, height: number, near: boolean) {
  const [state, setState] = useState<{ url: string | null; status: 'waiting' | 'loading' | 'ready' | 'error' }>({ url: null, status: 'waiting' });
  const [retry, setRetry] = useState(0);
  const currentUrl = useRef<string | null>(null), completeKey = useRef('');
  // Parent snapshots may clone every page. Unchanged artwork must not render again.
  const key = useMemo(() => JSON.stringify({ width, height, background: page.background, elements: page.elements }), [width, height, page.background, page.elements]);
  useEffect(() => {
    if (!near) return;
    if (completeKey.current === key) {
      setState(previous => previous.status === 'ready' ? previous : { ...previous, status: 'ready' });
      return;
    }
    let cancelled = false, cancelQueued = () => {};
    setState(previous => ({ ...previous, status: 'loading' }));
    // A drag or text edit can emit many document snapshots; only render settled artwork.
    const timer = window.setTimeout(() => {
      const snapshot = structuredClone(page);
      cancelQueued = queuePreview(async () => {
        if (cancelled) return;
        try {
          const blob = await renderPreview(snapshot, width, height, () => cancelled);
          if (!blob || cancelled) return;
          const url = URL.createObjectURL(blob);
          if (cancelled) { URL.revokeObjectURL(url); return; }
          const oldUrl = currentUrl.current;
          currentUrl.current = url; completeKey.current = key;
          setState({ url, status: 'ready' });
          if (oldUrl) URL.revokeObjectURL(oldUrl);
        } catch {
          if (!cancelled) setState(previous => ({ ...previous, status: 'error' }));
        }
      });
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); cancelQueued(); };
    // The key describes every visual input. Cloned but identical page objects stay cached.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, near, retry]);
  useEffect(() => () => { if (currentUrl.current) URL.revokeObjectURL(currentUrl.current); }, []);
  return { ...state, retry: () => { completeKey.current = ''; setRetry(value => value + 1); } };
}

function FilmIcon({ name }: { name: 'left' | 'right' | 'duplicate' | 'delete' | 'plus' | 'image' | 'retry' | 'more' }) {
  const paths = {
    left: <path d="m14 6-6 6 6 6" />,
    right: <path d="m10 6 6 6-6 6" />,
    duplicate: <><rect x="8" y="8" width="11" height="12" rx="2" /><path d="M15 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3" /></>,
    delete: <><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    image: <><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8" cy="8" r="1.5" /><path d="m3 17 5-5 4 4 4-6 5 7" /></>,
    retry: <><path d="M20 8V3l-3 3a8 8 0 1 0 2 10M20 3h-5" /></>,
    more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  };
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

interface SlideProps {
  page: DesignPage; index: number; total: number; width: number; height: number;
  selected: boolean; canEdit: boolean; disabled: boolean;
  list: RefObject<HTMLOListElement | null>;
  menuName: string;
  dragging: boolean; dropSide: 'before' | 'after' | null;
  onSelect: () => void; onDuplicate: () => void; onDelete: () => void; onMove: (to: number) => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  onDragStart: (event: DragEvent<HTMLLIElement>) => void;
  onDragOver: (event: DragEvent<HTMLLIElement>) => void;
  onDrop: (event: DragEvent<HTMLLIElement>) => void;
  onDragEnd: () => void;
}

function FilmstripActions({ props, retry }: { props: SlideProps; retry?: () => void }) {
  const details = useRef<HTMLDetailsElement>(null), summary = useRef<HTMLElement>(null), menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false), menuId = useId();
  function close(restoreFocus = false) {
    if (details.current) details.current.open = false;
    setOpen(false);
    if (restoreFocus) summary.current?.focus({ preventScroll: true });
  }
  useEffect(() => { if (props.disabled || props.dragging) close(); }, [props.disabled, props.dragging]);
  useLayoutEffect(() => {
    if (!open || !menu.current || !summary.current) return;
    const panel = menu.current, anchor = summary.current;
    const theme = getComputedStyle(anchor);
    for (const property of ['--ms-bg', '--ms-ink', '--ms-muted', '--ms-border', '--ms-accent', '--studio-surface', '--studio-inset', '--studio-control-hover', '--studio-danger-bg', '--studio-err', '--studio-link']) {
      const value = theme.getPropertyValue(property).trim();
      if (value) panel.style.setProperty(property, value);
    }
    panel.style.colorScheme = theme.colorScheme;
    const syncPopover = (event: Event) => { if ((event as ToggleEvent).newState === 'closed') close(); };
    const clickOutside = (event: PointerEvent) => { if (event.target instanceof Node && !panel.contains(event.target) && !details.current?.contains(event.target)) close(); };
    const focusOutside = (event: FocusEvent) => { if (event.target instanceof Node && !panel.contains(event.target) && !details.current?.contains(event.target)) close(); };
    const dismissOnScroll = (event: Event) => { if (event.target !== panel && !(event.target instanceof Node && panel.contains(event.target))) close(); };
    const dismissOnResize = () => close();
    panel.addEventListener('toggle', syncPopover);
    // The browser's top layer escapes scroll clipping, including in browser fullscreen.
    if (typeof panel.showPopover === 'function') panel.showPopover();
    const bounds = anchor.getBoundingClientRect(), panelWidth = panel.getBoundingClientRect().width;
    const panelHeight = Math.min(panel.scrollHeight, window.innerHeight - 24);
    const below = window.innerHeight - bounds.bottom, above = bounds.top;
    const proposedTop = above >= panelHeight + 8 || above >= below ? bounds.top - panelHeight - 8 : bounds.bottom + 8;
    panel.style.left = `${Math.max(12, Math.min(bounds.right - panelWidth, window.innerWidth - panelWidth - 12))}px`;
    panel.style.top = `${Math.max(12, Math.min(proposedTop, window.innerHeight - panelHeight - 12))}px`;
    panel.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
    window.addEventListener('pointerdown', clickOutside, true);
    window.addEventListener('focusin', focusOutside);
    window.addEventListener('scroll', dismissOnScroll, true);
    window.addEventListener('resize', dismissOnResize);
    return () => {
      panel.removeEventListener('toggle', syncPopover);
      window.removeEventListener('pointerdown', clickOutside, true);
      window.removeEventListener('focusin', focusOutside);
      window.removeEventListener('scroll', dismissOnScroll, true);
      window.removeEventListener('resize', dismissOnResize);
      if (typeof panel.hidePopover === 'function' && panel.matches(':popover-open')) panel.hidePopover();
    };
  }, [open]);
  const act = (action: () => void) => { close(true); action(); };
  const portalRoot = open && typeof globalThis.document !== 'undefined' ? globalThis.document.fullscreenElement ?? globalThis.document.body : null;
  return <details className="ms-filmstrip-more" name={props.menuName} ref={details} onToggle={event => {
    const expanded = event.currentTarget.open;
    if (expanded && props.disabled) { event.currentTarget.open = false; return; }
    if (expanded) for (const sibling of props.list.current?.querySelectorAll<HTMLDetailsElement>('details.ms-filmstrip-more[open]') ?? []) if (sibling !== event.currentTarget) sibling.open = false;
    setOpen(expanded);
  }}>
    <summary ref={summary} title={`More actions for slide ${props.index + 1}`} aria-label={`More actions for slide ${props.index + 1}`} aria-controls={menuId} aria-disabled={props.disabled} tabIndex={props.disabled ? -1 : 0} onClick={event => { if (props.disabled) event.preventDefault(); }} onKeyDown={event => { if (props.disabled || event.key === 'Escape') { event.preventDefault(); if (event.key === 'Escape') close(true); } }}><span><FilmIcon name="more" /></span></summary>
    {open && portalRoot && createPortal(<div id={menuId} className="ms-filmstrip-menu" ref={menu} popover="auto" data-open="true" role="group" aria-label={`Actions for slide ${props.index + 1}`} onToggle={event => event.stopPropagation()} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); } }}>
      <span className="ms-filmstrip-menu-label">Slide {props.index + 1}</span>
      <button type="button" className="ms-filmstrip-menu-action" disabled={props.disabled || props.index === 0} onClick={() => act(() => props.onMove(props.index - 1))}><FilmIcon name="left" />Move left</button>
      <button type="button" className="ms-filmstrip-menu-action" disabled={props.disabled || props.index === props.total - 1} onClick={() => act(() => props.onMove(props.index + 1))}><FilmIcon name="right" />Move right</button>
      <button type="button" className="ms-filmstrip-menu-action" disabled={props.disabled || props.total >= DESIGN_MAX_PAGES} onClick={() => act(props.onDuplicate)}><FilmIcon name="duplicate" />Duplicate slide</button>
      <button type="button" className="ms-filmstrip-menu-action ms-filmstrip-menu-delete" disabled={props.disabled || props.total <= 1} onClick={() => act(props.onDelete)}><FilmIcon name="delete" />Delete slide</button>
      {retry && <button type="button" className="ms-filmstrip-menu-action" disabled={props.disabled} onClick={() => act(retry)}><FilmIcon name="retry" />Retry preview</button>}
    </div>, portalRoot)}
  </details>;
}

function FilmstripSlide(props: SlideProps) {
  const item = useRef<HTMLLIElement>(null), near = useNearFilmstrip(item, props.list);
  const preview = usePreview(props.page, props.width, props.height, near || props.selected);
  const label = `Slide ${props.index + 1}: ${props.page.name}`;
  useEffect(() => {
    if (!props.selected || !item.current || !props.list.current) return;
    const list = props.list.current, target = item.current;
    const bounds = target.getBoundingClientRect(), viewport = list.getBoundingClientRect();
    const left = list.scrollLeft + bounds.left - viewport.left - list.clientLeft, right = left + target.offsetWidth;
    if (left < list.scrollLeft) list.scrollLeft = Math.max(0, left - 10);
    else if (right > list.scrollLeft + list.clientWidth) list.scrollLeft = right - list.clientWidth + 10;
  }, [props.selected, props.index, props.list]);
  return <li
    ref={item}
    className={`ms-filmstrip-slide${props.selected ? ' is-selected' : ''}${props.dragging ? ' is-dragging' : ''}${props.dropSide ? ` has-drop-${props.dropSide}` : ''}`}
    draggable={props.canEdit && !props.disabled && props.total > 1}
    onDragStart={props.onDragStart} onDragOver={props.onDragOver} onDrop={props.onDrop} onDragEnd={props.onDragEnd}
  >
    <button type="button" className="ms-filmstrip-select" data-slide-id={props.page.id} title={label} aria-label={label} aria-current={props.selected ? 'page' : undefined} disabled={props.disabled} onClick={props.onSelect} onKeyDown={props.onKeyDown}>
      <span className="ms-filmstrip-preview" style={{ backgroundColor: props.page.background }} aria-busy={preview.status === 'loading'}>
        {preview.url ? <img src={preview.url} alt="" draggable={false} /> : <span className="ms-filmstrip-placeholder"><FilmIcon name="image" /><span>{preview.status === 'error' ? 'Preview unavailable' : preview.status === 'loading' ? 'Loading preview' : 'Slide preview'}</span></span>}
        {preview.url && preview.status !== 'ready' && <span className={`ms-filmstrip-preview-state${preview.status === 'error' ? ' is-error' : ''}`} title={preview.status === 'error' ? 'Preview not updated' : 'Updating preview'}>{preview.status === 'error' ? 'Preview not updated' : 'Updating'}</span>}
        <span className="ms-filmstrip-number" aria-hidden="true">{props.index + 1}</span>
      </span>
    </button>
    {props.canEdit && <FilmstripActions props={props} retry={preview.status === 'error' ? preview.retry : undefined} />}
    {!props.canEdit && preview.status === 'error' && <button type="button" className="ms-filmstrip-retry" aria-label={`Retry preview for slide ${props.index + 1}`} title="Retry preview" disabled={props.disabled} onClick={preview.retry}><FilmIcon name="retry" /></button>}
  </li>;
}

export default function PageStrip({ document, pageIndex, canEdit, disabled, onSelect, onAdd, onDuplicate, onDelete, onMove }: PageStripProps) {
  const list = useRef<HTMLOListElement>(null), draggingId = useRef<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null), [drop, setDrop] = useState<{ id: string; side: 'before' | 'after' } | null>(null), [announcement, setAnnouncement] = useState('');
  const headingId = useId(), hintId = useId(), menuName = useId();
  const pages = document.pages;
  const clearDrag = () => { draggingId.current = null; setDragging(null); setDrop(null); };
  useEffect(() => { if (disabled || !canEdit) clearDrag(); }, [disabled, canEdit]);
  useEffect(() => { if (draggingId.current && !pages.some(page => page.id === draggingId.current)) clearDrag(); }, [pages]);
  function move(from: number, to: number) {
    if (disabled || !canEdit || from === to || from < 0 || to < 0 || from >= pages.length || to >= pages.length) return;
    onMove(from, to); setAnnouncement(`Moved slide ${from + 1} to position ${to + 1}.`);
  }
  function dragOver(event: DragEvent<HTMLLIElement>, page: DesignPage) {
    if (!draggingId.current || disabled || !canEdit) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'move';
    const bounds = event.currentTarget.getBoundingClientRect();
    setDrop({ id: page.id, side: event.clientX < bounds.left + bounds.width / 2 ? 'before' : 'after' });
  }
  function dropAt(event: DragEvent<HTMLLIElement>, target: number) {
    if (!draggingId.current || disabled || !canEdit) return;
    event.preventDefault();
    const from = pages.findIndex(page => page.id === draggingId.current), bounds = event.currentTarget.getBoundingClientRect();
    const gap = target + (event.clientX >= bounds.left + bounds.width / 2 ? 1 : 0);
    const to = Math.min(pages.length - 1, Math.max(0, gap - (from < gap ? 1 : 0)));
    clearDrag(); move(from, to);
  }
  function selectWithKeys(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (disabled || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const next = event.key === 'ArrowLeft' ? Math.max(0, index - 1) : event.key === 'ArrowRight' ? Math.min(pages.length - 1, index + 1) : event.key === 'Home' ? 0 : event.key === 'End' ? pages.length - 1 : null;
    if (next === null) return;
    event.preventDefault(); onSelect(next);
    const buttons = list.current?.querySelectorAll<HTMLButtonElement>('.ms-filmstrip-select');
    buttons?.[next]?.focus({ preventScroll: true });
  }
  return <section className="ms-filmstrip" aria-labelledby={headingId}>
    <div className="ms-filmstrip-heading"><h2 id={headingId}>Pages <span>{pages.length}/{DESIGN_MAX_PAGES}</span></h2><p id={hintId}>{canEdit ? 'Drag to reorder, or open a slide’s actions.' : 'Select a slide to view.'}</p></div>
    <div className="ms-filmstrip-track">
      <ol className="ms-filmstrip-list" ref={list} style={{ '--ms-filmstrip-page-ratio': document.width / document.height } as CSSProperties} aria-label="Carousel slides" aria-describedby={hintId} onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDrop(null); }}>
        {pages.map((page, index) => <FilmstripSlide key={page.id}
          page={page} index={index} total={pages.length} width={document.width} height={document.height} selected={index === pageIndex}
          canEdit={canEdit} disabled={disabled} list={list} menuName={menuName} dragging={dragging === page.id} dropSide={drop?.id === page.id ? drop.side : null}
          onSelect={() => onSelect(index)} onDuplicate={() => onDuplicate(index)} onDelete={() => onDelete(index)} onMove={to => move(index, to)} onKeyDown={event => selectWithKeys(event, index)}
          onDragStart={event => {
            if (disabled || !canEdit || (event.target as HTMLElement).closest('.ms-filmstrip-more, .ms-filmstrip-retry')) { event.preventDefault(); return; }
            for (const menu of list.current?.querySelectorAll<HTMLDetailsElement>('details.ms-filmstrip-more[open]') ?? []) menu.open = false;
            draggingId.current = page.id; setDragging(page.id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', page.id);
          }}
          onDragOver={event => dragOver(event, page)} onDrop={event => dropAt(event, index)} onDragEnd={clearDrag}
        />)}
      </ol>
      {canEdit && <button type="button" className="ms-filmstrip-add" disabled={disabled || pages.length >= DESIGN_MAX_PAGES} onClick={onAdd} aria-label="Add a blank slide" title={pages.length >= DESIGN_MAX_PAGES ? 'Maximum 12 slides' : 'Add a blank slide'}><FilmIcon name="plus" /></button>}
    </div>
    <span className="ms-filmstrip-announcement" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
  </section>;
}
