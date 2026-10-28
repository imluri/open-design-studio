import { useEffect, useRef, useState } from 'react';
import type { Canvas, Textbox } from 'fabric';
import { DESIGN_FONTS, DESIGN_MAX_ELEMENTS, DESIGN_MAX_PAGES, validateDesignDocument, validateProject, type DesignDocument, type DesignElement, type DesignElementBase, type DesignFont, type Project, type ProjectSummary } from './core/model';
import { createProject, TEMPLATES } from './core/templates';
import { getProject, listProjects, saveProject } from './core/storage';
import { parseProjectFile, projectBlob } from './core/project-files';
import { designFilename, downloadBlob, exportPage, exportPages, importImage, pageObjects, readCanvasPage, type LayerObject } from './core/canvas';
import { alignmentDelta, attachAlignmentGuides, getObjectBounds, type AlignmentGuide, type AlignmentKind } from './core/alignment';
import useCanvasViewport from './ui/useCanvasViewport';
import Inspector, { NumberField, type ElementPatch } from './ui/Inspector';
import PageStrip from './ui/PageStrip';
import Icon from './ui/Icon';

const clone = <T,>(value: T): T => structuredClone(value);
// Keep immutable image strings shared across history entries instead of copying
// megabytes of embedded artwork for each small property change.
const copyDocument = (value: DesignDocument): DesignDocument => ({ ...value, pages: value.pages.map(page => ({ ...page, elements: page.elements.map(element => ({ ...element })) })) });
function sameDocument(a: DesignDocument, b: DesignDocument): boolean {
  return a === b || a.width === b.width && a.height === b.height && a.pages.length === b.pages.length && a.pages.every((page, index) => {
    const other = b.pages[index];
    return page.id === other.id && page.name === other.name && page.background === other.background && page.elements.length === other.elements.length && page.elements.every((element, at) => {
      const right = other.elements[at] as unknown as Record<string, unknown>, left = element as unknown as Record<string, unknown>;
      return Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(key => left[key] === right[key]);
    });
  });
}
const uid = () => crypto.randomUUID();
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'This action could not be completed. Your design is still here.';
type Panel = 'templates' | 'elements' | 'text' | 'projects';
type Format = 'png' | 'jpeg' | 'svg';

export default function App() {
  const [project, setProject] = useState<Project>(() => createProject('bold-announcement'));
  const [pageIndex, setPageIndex] = useState(0), [selectedId, setSelectedId] = useState<string | null>(null);
  const [ready, setReady] = useState(false), [rendering, setRendering] = useState(false), [started, setStarted] = useState(false);
  const [dirty, setDirty] = useState(false), [status, setStatus] = useState('Loading local projects…');
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [canvasFailed, setCanvasFailed] = useState(false);
  const [alignmentGuides, setAlignmentGuides] = useState<AlignmentGuide[]>([]);
  const [snapping, setSnapping] = useState(() => { try { return localStorage.getItem('ods:snapping') !== 'off'; } catch { return true; } });
  const [panel, setPanel] = useState<Panel>('templates'), [panelOpen, setPanelOpen] = useState(false);
  const [inspector, setInspector] = useState(false), [inspectorTab, setInspectorTab] = useState<'edit' | 'layers'>('edit');
  const [projects, setProjects] = useState<ProjectSummary[]>([]), [query, setQuery] = useState('');
  const [counts, setCounts] = useState({ undo: 0, redo: 0 }), [typingTick, setTypingTick] = useState(0), [showPages, setShowPages] = useState(true);
  const [format, setFormat] = useState<Format>('png'), [resolution, setResolution] = useState<1 | 2>(1);
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem('ods:theme') === 'light' ? 'light' : 'dark'; } catch { return 'dark'; } });
  const canvasElement = useRef<HTMLCanvasElement>(null), canvas = useRef<Canvas | null>(null), stage = useRef<HTMLDivElement>(null), app = useRef<HTMLDivElement>(null);
  const imageInput = useRef<HTMLInputElement>(null), fileInput = useRef<HTMLInputElement>(null), fileMenu = useRef<HTMLDetailsElement>(null), exportMenu = useRef<HTMLDetailsElement>(null), shortcuts = useRef<HTMLDialogElement>(null);
  const projectRef = useRef(project), pageRef = useRef(pageIndex), selectionRef = useRef(selectedId), dirtyRef = useRef(dirty), busyRef = useRef(busy);
  projectRef.current = project; pageRef.current = pageIndex; selectionRef.current = selectedId; dirtyRef.current = dirty; busyRef.current = busy;
  const renderVersion = useRef(0), renderingRef = useRef(false), renderedDocument = useRef<DesignDocument | null>(null), renderedPageId = useRef<string | null>(null);
  const generation = useRef(0), writes = useRef<Promise<unknown>>(Promise.resolve()), history = useRef<{ undo: DesignDocument[]; redo: DesignDocument[] }>({ undo: [], redo: [] });
  const callbacks = useRef({ modified: () => {}, typing: () => {}, save: () => Promise.resolve(true) });
  const document = project.document, page = document.pages[pageIndex] ?? document.pages[0], selected = page.elements.find(item => item.id === selectedId);
  const disabled = Boolean(busy) || !started;
  const viewport = useCanvasViewport({ stage, canvas, ready, width: document.width, height: document.height, pageId: page.id, disabled: disabled || rendering });
  const refreshLayout = viewport.refreshLayout;
  const alignmentRuntime = useRef({ snapping, scale: viewport.scale, blocked: disabled || rendering || viewport.handTool || viewport.panning });
  alignmentRuntime.current = { snapping, scale: viewport.scale, blocked: disabled || rendering || viewport.handTool || viewport.panning };

  function markDirty() { generation.current++; dirtyRef.current = true; setDirty(true); setStatus('Unsaved changes'); }
  function capture(): DesignDocument {
    const current = projectRef.current.document;
    if (!canvas.current || renderingRef.current || renderedDocument.current !== current || renderedPageId.current !== current.pages[pageRef.current]?.id) return current;
    const next = copyDocument(current); next.pages[pageRef.current] = readCanvasPage(canvas.current, current.pages[pageRef.current]); return next;
  }
  function settleText() {
    const active = canvas.current?.getActiveObject() as Textbox | undefined;
    if (active?.isEditing) active.exitEditing();
  }
  function commit(next: DesignDocument, remember = true) {
    if (sameDocument(next, projectRef.current.document)) return;
    try {
      const clean = validateDesignDocument(next);
      if (remember) { history.current.undo.push(projectRef.current.document); history.current.undo = history.current.undo.slice(-40); history.current.redo = []; }
      const updated = { ...projectRef.current, document: clean };
      projectRef.current = updated; setProject(updated); markDirty(); setMessage('');
      setCounts({ undo: history.current.undo.length, redo: history.current.redo.length });
    } catch (caught) { setError(errorMessage(caught)); }
  }
  function select(id: string | null) {
    const instance = canvas.current, object = instance?.getObjects().find(raw => (raw as LayerObject).studioId === id);
    if (object?.selectable) instance?.setActiveObject(object); else instance?.discardActiveObject();
    selectionRef.current = id; setSelectedId(id); instance?.requestRenderAll();
  }
  function change(patch: ElementPatch, id = selectionRef.current ?? undefined) {
    if (disabled || !id) return;
    const next = copyDocument(capture());
    next.pages[pageRef.current].elements = next.pages[pageRef.current].elements.map(element => element.id === id ? { ...element, ...patch } as DesignElement : element);
    commit(next);
  }
  function add(type: 'text' | 'rect' | 'ellipse' | 'image', values: Partial<DesignElementBase> & { text?: string; fontSize?: number; fontWeight?: 400 | 700; src?: string } = {}) {
    if (disabled || renderingRef.current) return;
    settleText(); const next = copyDocument(capture()), elements = next.pages[pageRef.current].elements;
    if (elements.length >= DESIGN_MAX_ELEMENTS) { setError(`Each page supports up to ${DESIGN_MAX_ELEMENTS} layers.`); return; }
    const base: DesignElementBase = { id: uid(), name: type === 'text' ? 'Text' : type === 'image' ? 'Image' : type === 'rect' ? 'Rectangle' : 'Circle', x: 90, y: 180, width: type === 'text' ? Math.min(760, next.width - 120) : 300, height: type === 'text' ? 160 : 300, rotation: 0, opacity: 1, locked: false, visible: true, ...values };
    const element: DesignElement = type === 'text' ? { ...base, type, text: values.text ?? 'Your next great idea', fontSize: values.fontSize ?? 72, fontFamily: 'Arial', fontWeight: values.fontWeight ?? 700, textAlign: 'left', fill: '#7568ED' } : type === 'image' ? { ...base, type, src: values.src! } : type === 'rect' ? { ...base, type, fill: '#7568ED', borderRadius: 18 } : { ...base, type, fill: '#FF957A' };
    elements.push(element); selectionRef.current = element.id; setSelectedId(element.id); viewport.setHandTool(false); commit(next);
    if (window.innerWidth <= 760) setPanelOpen(false);
  }
  function duplicate() {
    if (disabled || renderingRef.current) return;
    const next = copyDocument(capture()), elements = next.pages[pageRef.current].elements, found = elements.find(item => item.id === selectionRef.current);
    if (!found || found.locked || elements.length >= DESIGN_MAX_ELEMENTS) return;
    const copy = { ...clone(found), id: uid(), name: `${found.name.slice(0, 150)} copy`, x: Math.min(16000, found.x + 24), y: Math.min(16000, found.y + 24) };
    elements.push(copy); selectionRef.current = copy.id; setSelectedId(copy.id); commit(next);
  }
  function remove() {
    if (disabled || renderingRef.current) return;
    const next = copyDocument(capture()), elements = next.pages[pageRef.current].elements;
    if (elements.find(item => item.id === selectionRef.current)?.locked) return;
    next.pages[pageRef.current].elements = elements.filter(item => item.id !== selectionRef.current); select(null); commit(next);
  }
  function reorder(direction: number) {
    if (disabled || renderingRef.current) return;
    const next = copyDocument(capture()), elements = next.pages[pageRef.current].elements, index = elements.findIndex(item => item.id === selectionRef.current);
    if (index < 0 || elements[index].locked) return;
    const target = Math.max(0, Math.min(elements.length - 1, index + direction));
    if (target === index) return; const [item] = elements.splice(index, 1); elements.splice(target, 0, item); commit(next);
  }
  function alignElement(kind: AlignmentKind, referenceId: string | null) {
    if (disabled || renderingRef.current || viewport.isInteracting() || !canvas.current) return;
    settleText();
    if (renderedDocument.current !== projectRef.current.document || renderedPageId.current !== projectRef.current.document.pages[pageRef.current]?.id) return;
    const instance = canvas.current, next = copyDocument(capture()), elements = next.pages[pageRef.current].elements;
    const element = elements.find(item => item.id === selectionRef.current);
    const target = (instance.getObjects() as LayerObject[]).find(object => object.studioId === element?.id);
    if (!element || element.locked || !element.visible || element.opacity <= 0 || !target) return;
    let reference = { left: 0, top: 0, width: next.width, height: next.height };
    if (referenceId !== null) {
      const source = elements.find(item => item.id === referenceId && item.id !== element.id && item.visible && item.opacity > 0);
      const object = (instance.getObjects() as LayerObject[]).find(item => item.studioId === source?.id);
      if (!source || !object) { setError('Choose a visible layer to align to.'); return; }
      reference = getObjectBounds(object);
    }
    const delta = alignmentDelta(getObjectBounds(target), reference, kind);
    element.x = Math.round((element.x + delta.x) * 100) / 100;
    element.y = Math.round((element.y + delta.y) * 100) / 100;
    setAlignmentGuides([]); commit(next);
  }
  function showAlignment() {
    setInspectorTab('edit'); setInspector(true);
    if (window.innerWidth <= 760) setPanelOpen(false);
  }
  function undo(redo = false) {
    if (disabled || renderingRef.current) return;
    settleText(); const from = redo ? history.current.redo : history.current.undo, to = redo ? history.current.undo : history.current.redo, previous = from.pop();
    if (!previous) return; to.push(capture()); select(null); setPageIndex(index => Math.min(index, previous.pages.length - 1)); commit(previous, false);
  }
  function showProperties(tab: 'edit' | 'layers' = 'edit', pageSettings = false) {
    if (disabled) return; if (pageSettings) select(null);
    setInspectorTab(tab); setInspector(current => pageSettings || inspectorTab !== tab || !current);
    if (window.innerWidth <= 760) setPanelOpen(false);
  }
  function switchPage(index: number) { if (disabled || renderingRef.current) return; settleText(); const snapshot = capture(); if (snapshot !== projectRef.current.document) { projectRef.current = { ...projectRef.current, document: snapshot }; setProject(projectRef.current); } select(null); setPageIndex(index); }
  function addPage(copyIndex?: number) {
    if (disabled || renderingRef.current || document.pages.length >= DESIGN_MAX_PAGES) return;
    settleText(); const next = copyDocument(capture());
    const added = copyIndex === undefined ? { id: uid(), name: `Page ${next.pages.length + 1}`, background: '#FFFFFF', elements: [] } : { ...clone(next.pages[copyIndex]), id: uid(), name: `${next.pages[copyIndex].name.slice(0, 150)} copy`, elements: next.pages[copyIndex].elements.map(item => ({ ...item, id: uid() })) };
    const index = copyIndex === undefined ? next.pages.length : copyIndex + 1; next.pages.splice(index, 0, added); select(null); setPageIndex(index); commit(next);
  }
  function deletePage(index: number) {
    if (disabled || renderingRef.current || document.pages.length < 2) return;
    const next = copyDocument(capture()); next.pages.splice(index, 1); select(null); setPageIndex(current => Math.max(0, Math.min(next.pages.length - 1, current > index ? current - 1 : current))); commit(next);
  }
  function movePage(from: number, to: number) {
    if (disabled || renderingRef.current) return;
    const next = copyDocument(capture()), active = next.pages[pageRef.current].id, [moved] = next.pages.splice(from, 1); next.pages.splice(to, 0, moved); setPageIndex(next.pages.findIndex(item => item.id === active)); commit(next);
  }

  async function refreshProjects() { setProjects(await listProjects()); }
  async function saveLocal(notify = false): Promise<boolean> {
    if (!started || busyRef.current === 'Opening project') return false;
    const version = generation.current;
    let snapshot: Project;
    try { snapshot = validateProject({ ...projectRef.current, title: projectRef.current.title.trim() || 'Untitled design', document: capture(), updatedAt: new Date().toISOString() }); }
    catch (caught) { setError(errorMessage(caught)); setStatus('Not saved'); return false; }
    setStatus('Saving on this device…');
    const pending = writes.current.catch(() => {}).then(() => saveProject(snapshot)); writes.current = pending;
    try {
      await pending;
      if (projectRef.current.id === snapshot.id && generation.current === version) {
        dirtyRef.current = false; setDirty(false); setStatus('Saved on this device');
        projectRef.current = { ...projectRef.current, title: snapshot.title, updatedAt: snapshot.updatedAt }; setProject(projectRef.current);
        try { localStorage.setItem('ods:last-project', snapshot.id); } catch { /* The library still works without the recent-project preference. */ }
      }
      await refreshProjects(); if (notify) setMessage('Saved on this device. Download a project file to keep a separate backup.'); return true;
    } catch (caught) { setStatus('Local save failed'); setError(`${errorMessage(caught)} Download your editable project to keep a copy.`); return false; }
  }
  callbacks.current = {
    modified: () => { if (!renderingRef.current && !busyRef.current) commit(capture()); },
    typing: () => { if (!renderingRef.current) { markDirty(); setTypingTick(tick => tick + 1); } },
    save: () => saveLocal(),
  };
  function activate(next: Project, saved: boolean) {
    canvas.current?.discardActiveObject(); projectRef.current = next; setProject(next); setPageIndex(0); pageRef.current = 0; select(null);
    history.current = { undo: [], redo: [] }; setCounts({ undo: 0, redo: 0 }); generation.current++;
    dirtyRef.current = !saved; setDirty(!saved); setStatus(saved ? 'Saved on this device' : 'Unsaved changes'); setError(''); setMessage('');
    viewport.setHandTool(false); viewport.fit();
    try { localStorage.setItem('ods:last-project', next.id); } catch { /* Optional preference. */ }
  }
  async function newProject(template = 'blank') {
    if (disabled || busyRef.current) return; settleText(); busyRef.current = 'Preparing project'; setBusy('Preparing project');
    try { if (dirtyRef.current && (!await saveLocal() || dirtyRef.current)) return; activate(createProject(template), false); if (window.innerWidth <= 760) setPanelOpen(false); }
    catch (caught) { setError(errorMessage(caught)); } finally { busyRef.current = ''; setBusy(''); }
  }
  async function openSaved(id: string) {
    if (disabled || busyRef.current) return; settleText(); busyRef.current = 'Preparing project'; setBusy('Preparing project');
    try { if (dirtyRef.current && (!await saveLocal() || dirtyRef.current)) return; busyRef.current = 'Opening project'; setBusy('Opening project'); const result = await getProject(id); if (!result) throw new Error('This local project is no longer available.'); activate(result, true); setPanelOpen(false); }
    catch (caught) { setError(errorMessage(caught)); } finally { busyRef.current = ''; setBusy(''); }
  }
  async function openFile(file?: File) {
    if (!file || disabled || busyRef.current) return; settleText(); busyRef.current = 'Preparing project'; setBusy('Preparing project');
    try { if (dirtyRef.current && (!await saveLocal() || dirtyRef.current)) return; busyRef.current = 'Opening project'; setBusy('Opening project'); const incoming = await parseProjectFile(file); activate({ ...incoming, id: uid(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, false); setMessage('Project opened as a new local copy.'); }
    catch (caught) { setError(errorMessage(caught)); } finally { busyRef.current = ''; setBusy(''); if (fileInput.current) fileInput.current.value = ''; }
  }
  async function duplicateProject() {
    if (disabled || busyRef.current) return; settleText(); busyRef.current = 'Preparing project'; setBusy('Preparing project');
    try {
      if (dirtyRef.current && (!await saveLocal() || dirtyRef.current)) return;
      const current = projectRef.current, now = new Date().toISOString();
      activate({ ...current, id: uid(), title: `${current.title.slice(0, 150)} copy`, document: copyDocument(current.document), createdAt: now, updatedAt: now }, false);
    } catch (caught) { setError(errorMessage(caught)); } finally { busyRef.current = ''; setBusy(''); }
  }
  async function addImages(files: FileList | File[] | null) {
    if (!files?.length || disabled || busyRef.current) return; settleText(); busyRef.current = 'Importing image'; setBusy('Importing image');
    try {
      const next = copyDocument(capture()), elements = next.pages[pageRef.current].elements;
      if (elements.length + files.length > DESIGN_MAX_ELEMENTS) throw new Error('This page does not have enough free layers for those images.');
      for (const file of Array.from(files)) {
        const image = await importImage(file), scale = Math.min(next.width * .72 / image.width, next.height * .72 / image.height, 1);
        const width = image.width * scale, height = image.height * scale;
        elements.push({ id: uid(), type: 'image', name: image.name.slice(0, 160), src: image.src, x: (next.width - width) / 2, y: (next.height - height) / 2, width, height, rotation: 0, opacity: 1, visible: true, locked: false });
      }
      selectionRef.current = elements.at(-1)!.id; setSelectedId(selectionRef.current); commit(next); setPanelOpen(false);
    } catch (caught) { setError(errorMessage(caught)); } finally { busyRef.current = ''; setBusy(''); if (imageInput.current) imageInput.current.value = ''; }
  }
  function downloadProject() {
    try { settleText(); const snapshot = validateProject({ ...projectRef.current, document: capture(), title: projectRef.current.title.trim() || 'Untitled design', updatedAt: new Date().toISOString() }); downloadBlob(projectBlob(snapshot), `${designFilename(snapshot.title)}.design.json`); setMessage('Editable project downloaded with its images included.'); }
    catch (caught) { setError(errorMessage(caught)); }
  }
  async function exportArtwork(all = false) {
    if (disabled || busyRef.current || !ready || renderingRef.current) return; settleText(); busyRef.current = 'Exporting design'; setBusy('Exporting design'); setError('');
    try { const snapshot = validateDesignDocument(capture()), blob = all ? await exportPages(snapshot, format, resolution) : await exportPage(snapshot, pageRef.current, format, resolution); downloadBlob(blob, `${designFilename(projectRef.current.title)}${all ? '-pages.zip' : `-${pageRef.current + 1}.${format === 'jpeg' ? 'jpg' : format}`}`); setMessage(all ? 'Pages downloaded as a ZIP file.' : 'Page downloaded.'); }
    catch (caught) { setError(errorMessage(caught)); } finally { busyRef.current = ''; setBusy(''); if (exportMenu.current) exportMenu.current.open = false; }
  }

  useEffect(() => {
    let cancelled = false, instance: Canvas | undefined;
    void import('fabric').then(({ Canvas }) => {
      if (cancelled || !canvasElement.current) return;
      instance = new Canvas(canvasElement.current, { enableRetinaScaling: false, preserveObjectStacking: true, selection: false }); canvas.current = instance;
      instance.on('object:modified', () => callbacks.current.modified()); instance.on('text:editing:exited', () => callbacks.current.modified()); instance.on('text:changed', () => callbacks.current.typing());
      const selection = () => { if (renderingRef.current) return; const id = (instance!.getActiveObject() as LayerObject | undefined)?.studioId ?? null; selectionRef.current = id; setSelectedId(id); };
      instance.on('selection:created', selection); instance.on('selection:updated', selection); instance.on('selection:cleared', selection); setReady(true);
    }).catch(caught => setError(errorMessage(caught)));
    return () => { cancelled = true; canvas.current = null; void instance?.dispose(); };
  }, []);
  useEffect(() => {
    const instance = canvas.current; if (!ready || !instance) return;
    const version = ++renderVersion.current; renderingRef.current = true; setRendering(true); setCanvasFailed(false); renderedDocument.current = null;
    void pageObjects(page, true).then(objects => {
      if (version !== renderVersion.current || instance.disposed || instance.destroyed) { objects.forEach(object => object.dispose()); return; }
      instance.clear(); instance.setDimensions({ width: document.width, height: document.height }); instance.backgroundColor = page.background; instance.add(...objects);
      const active = objects.find(object => object.studioId === selectionRef.current); if (active?.selectable) instance.setActiveObject(active);
      instance.renderAll(); renderedDocument.current = document; renderedPageId.current = page.id; renderingRef.current = false; setRendering(false); refreshLayout();
    }).catch(caught => { if (version === renderVersion.current) { instance.clear(); instance.backgroundColor = page.background; instance.requestRenderAll(); renderingRef.current = false; setRendering(false); setCanvasFailed(true); setError(`${errorMessage(caught)} Your project is preserved. Use Layers to remove an unavailable image, or download the editable project.`); } });
    return () => { renderVersion.current++; };
  }, [document, pageIndex, ready, refreshLayout]);
  useEffect(() => {
    const instance = canvas.current; if (!ready || !instance) return;
    return attachAlignmentGuides(instance, {
      isEnabled: () => alignmentRuntime.current.snapping,
      isBlocked: () => alignmentRuntime.current.blocked || renderingRef.current || Boolean(busyRef.current),
      getScale: () => alignmentRuntime.current.scale,
      getPageSize: () => ({ width: projectRef.current.document.width, height: projectRef.current.document.height }),
      onGuides: setAlignmentGuides,
    });
  }, [ready]);
  useEffect(() => { setAlignmentGuides([]); }, [document, page.id, viewport.scale, viewport.handTool, viewport.panning, snapping]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const stored = await listProjects(); if (cancelled) return; setProjects(stored);
        let recent: string | null = null; try { recent = localStorage.getItem('ods:last-project'); } catch { /* Optional preference. */ }
        const id = stored.find(item => item.id === recent)?.id ?? stored[0]?.id;
        if (id) { const saved = await getProject(id); if (!cancelled && saved) activate(saved, true); }
        else setStatus('Ready to create');
      } catch (caught) { if (!cancelled) { setStatus('Local storage unavailable'); setError(`${errorMessage(caught)} You can still edit and download project files.`); } }
      finally { if (!cancelled) setStarted(true); }
    })();
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!dirty || !started || busy || rendering) return;
    const timer = window.setTimeout(() => { void saveLocal(); }, 850); return () => window.clearTimeout(timer);
  }, [project, dirty, started, busy, rendering, typingTick]);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => { if (dirtyRef.current) { void callbacks.current.save(); event.preventDefault(); } };
    const visibility = () => { if (window.document.hidden && dirtyRef.current) void callbacks.current.save(); };
    window.addEventListener('beforeunload', unload); window.document.addEventListener('visibilitychange', visibility);
    return () => { window.removeEventListener('beforeunload', unload); window.document.removeEventListener('visibilitychange', visibility); };
  }, []);
  useEffect(() => { try { localStorage.setItem('ods:theme', theme); } catch { /* Optional preference. */ } }, [theme]);
  useEffect(() => { try { localStorage.setItem('ods:snapping', snapping ? 'on' : 'off'); } catch { /* Optional preference. */ } }, [snapping]);
  useEffect(() => {
    const outside = (event: PointerEvent) => { for (const menu of [fileMenu.current, exportMenu.current]) if (menu?.open && !menu.contains(event.target as Node)) menu.open = false; };
    window.document.addEventListener('pointerdown', outside); return () => window.document.removeEventListener('pointerdown', outside);
  }, []);
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || shortcuts.current?.open) return;
      const target = event.target instanceof Element ? event.target : null, modified = event.ctrlKey || event.metaKey, key = event.key.toLowerCase();
      if (modified && key === 's') { event.preventDefault(); if (!disabled && !event.repeat) { settleText(); void saveLocal(true); } return; }
      if (target?.closest('input,textarea,select,[contenteditable],dialog,[popover]') || (canvas.current?.getActiveObject() as Textbox | undefined)?.isEditing) return;
      if (!app.current?.contains(window.document.activeElement)) return;
      if (event.key === 'Escape') { for (const menu of [fileMenu.current, exportMenu.current]) if (menu?.open) { event.preventDefault(); menu.open = false; return; } if (inspector) { setInspector(false); return; } if (panelOpen) { setPanelOpen(false); return; } viewport.setHandTool(false); select(null); return; }
      if (fileMenu.current?.open || exportMenu.current?.open || disabled || renderingRef.current || viewport.isInteracting()) return;
      if (!modified && key === '?') { event.preventDefault(); shortcuts.current?.showModal(); }
      else if (modified && key === 'z') { event.preventDefault(); undo(event.shiftKey); }
      else if (event.ctrlKey && key === 'y') { event.preventDefault(); undo(true); }
      else if (modified && key === 'd') { event.preventDefault(); if (!event.repeat) duplicate(); }
      else if (!modified && ['Delete', 'Backspace'].includes(event.key) && !target?.closest('button,summary,a')) { event.preventDefault(); remove(); }
      else if (!modified && ['h', 'v'].includes(key)) { event.preventDefault(); viewport.setHandTool(key === 'h'); }
      else if (event.shiftKey && event.code === 'Digit1') { event.preventDefault(); viewport.fit(); }
      else if (event.shiftKey && event.code === 'Digit0') { event.preventDefault(); viewport.actualSize(); }
      else if (!modified && stage.current?.contains(window.document.activeElement)) {
        if (key === '+' || key === '=') { event.preventDefault(); viewport.zoomIn(); }
        else if (key === '-') { event.preventDefault(); viewport.zoomOut(); }
        else if (!event.repeat && ['t', 'r', 'o'].includes(key)) { event.preventDefault(); add(key === 't' ? 'text' : key === 'r' ? 'rect' : 'ellipse'); }
        else if (selected && !selected.locked && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); const amount = event.shiftKey ? 10 : 1; change({ x: Math.max(-16384, Math.min(16384, selected.x + (event.key === 'ArrowRight' ? amount : event.key === 'ArrowLeft' ? -amount : 0))), y: Math.max(-16384, Math.min(16384, selected.y + (event.key === 'ArrowDown' ? amount : event.key === 'ArrowUp' ? -amount : 0))) }); }
      }
    };
    window.addEventListener('keydown', keys); return () => window.removeEventListener('keydown', keys);
  });

  const openPanel = (next: Panel) => { setPanel(next); setPanelOpen(current => next !== panel || !current); if (window.innerWidth <= 1100) setInspector(false); if (next === 'projects') void refreshProjects().catch(caught => setError(errorMessage(caught))); };
  const hasSaved = projects.some(item => item.id === project.id), visualBusy = disabled || Boolean(rendering);
  return <div className={`studio ${panelOpen ? 'panel-open' : ''} ${inspector ? 'inspector-open' : ''}`} data-theme={theme} ref={app} tabIndex={-1}>
    <header className="topbar">
      <button className="brand-button" title="Open Design Studio · Local projects" aria-label="Open local projects" onClick={() => openPanel('projects')}><Icon name="logo" size={24} /></button>
      <details className="file-menu" ref={fileMenu} name="document-menu"><summary>File <Icon name="chevron" size={12} /></summary><div className="dropdown" onClick={event => { if ((event.target as Element).closest('button') && fileMenu.current) fileMenu.current.open = false; }}><span className="menu-label">Open Design Studio</span><button disabled={disabled} onClick={() => void newProject()}><Icon name="plus" />New blank design</button><button disabled={disabled} onClick={() => fileInput.current?.click()}><Icon name="folder" />Open project file</button><button disabled={disabled} onClick={() => void saveLocal(true)}><Icon name="save" />Save on this device <kbd>Ctrl S</kbd></button><button disabled={visualBusy} onClick={downloadProject}><Icon name="download" />Download editable project</button><button disabled={disabled} onClick={() => void duplicateProject()}><Icon name="duplicate" />Make a copy</button><hr /><button disabled={visualBusy} onClick={() => undo()}><Icon name="undo" />Undo</button><button disabled={visualBusy} onClick={() => undo(true)}><Icon name="redo" />Redo</button><button disabled={disabled} onClick={() => showProperties('edit', true)}><Icon name="expand" />Canvas size</button><button onClick={() => setTheme(value => value === 'dark' ? 'light' : 'dark')}><Icon name="theme" />{theme === 'dark' ? 'Light' : 'Dark'} appearance</button><button onClick={() => shortcuts.current?.showModal()}><Icon name="keyboard" />Keyboard shortcuts</button><p className="menu-note">Projects stay in this browser. Download editable files for backups or another device.</p></div></details>
      <button className="header-command resize-command" disabled={disabled} onClick={() => showProperties('edit', true)}><Icon name="expand" size={16} /><span>Resize</span></button><span className="header-divider" />
      <button className="icon-button" aria-label="Undo" title="Undo (Ctrl Z)" disabled={visualBusy || !counts.undo} onClick={() => undo()}><Icon name="undo" /></button><button className="icon-button redo-command" aria-label="Redo" title="Redo (Ctrl Shift Z)" disabled={visualBusy || !counts.redo} onClick={() => undo(true)}><Icon name="redo" /></button>
      <div className="design-title"><label className="sr-only" htmlFor="design-title">Design name</label><input id="design-title" placeholder="Name your design" value={project.title} maxLength={160} disabled={disabled} onChange={event => { const next = { ...projectRef.current, title: event.target.value }; projectRef.current = next; setProject(next); markDirty(); }} /></div>
      <span className={`save-indicator ${dirty ? 'pending' : ''}`} role="status" title={status}><Icon name={!dirty && hasSaved ? 'check' : 'device'} size={16} /><span>{busy || status}</span></span>
      <button className="icon-button save-command" aria-label="Save on this device" title={status} disabled={disabled} onClick={() => { settleText(); void saveLocal(true); }}><Icon name={!dirty && hasSaved ? 'check' : 'save'} /></button>
      <details className="export-menu" ref={exportMenu} name="document-menu"><summary className="export-command"><Icon name="download" /><span>Export</span><Icon name="chevron" size={12} /></summary><div className="dropdown export-settings"><strong>Export your design</strong><label>File type<select value={format} onChange={event => setFormat(event.target.value as Format)}><option value="png">PNG image</option><option value="jpeg">JPEG image</option><option value="svg">SVG artwork</option></select></label><label>Resolution<select value={resolution} disabled={format === 'svg'} onChange={event => setResolution(Number(event.target.value) as 1 | 2)}><option value={1}>Standard · 1×</option><option value={2}>High resolution · 2×</option></select></label><span className="help">{document.width * (format === 'svg' ? 1 : resolution)} × {document.height * (format === 'svg' ? 1 : resolution)} px</span><button className="button primary" disabled={visualBusy || !ready} onClick={() => void exportArtwork()}><Icon name="download" />Current page</button><button className="button" disabled={visualBusy || !ready} onClick={() => void exportArtwork(true)}>All {document.pages.length} pages as ZIP</button><button className="text-button" disabled={visualBusy} onClick={downloadProject}>Download editable project instead</button><p className="help">SVG uses system fonts. Font availability can change how text appears on another device.</p></div></details>
    </header>
    {error && <div className="notice error" role="alert"><span>{error}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><Icon name="close" size={16} /></button></div>}
    {message && <div className="notice" role="status"><Icon name="check" size={16} /><span>{message}</span><button className="icon-button" aria-label="Dismiss message" onClick={() => setMessage('')}><Icon name="close" size={16} /></button></div>}
    <div className="workspace">
      <nav className="tool-rail" aria-label="Design tools">{([{ id: 'templates', label: 'Design', icon: 'templates' }, { id: 'elements', label: 'Elements', icon: 'elements' }, { id: 'text', label: 'Text', icon: 'text' }, { id: 'projects', label: 'Projects', icon: 'folder' }] as const).map(item => <button key={item.id} aria-pressed={panelOpen && panel === item.id} aria-expanded={panelOpen && panel === item.id} aria-controls="resource-panel" onClick={() => openPanel(item.id)}><Icon name={item.icon} size={23} /><span>{item.label}</span></button>)}<button disabled={disabled} onClick={() => imageInput.current?.click()} title="Upload a PNG, JPEG or WebP image"><Icon name="upload" size={23} /><span>Upload</span></button><div className="rail-bottom"><button aria-label="Change appearance" title="Change appearance" onClick={() => setTheme(value => value === 'dark' ? 'light' : 'dark')}><Icon name="theme" /></button></div></nav>
      {panelOpen && <button className="panel-scrim" aria-label="Close resource panel" onClick={() => setPanelOpen(false)} />}
      <aside className="resource-panel" id="resource-panel" hidden={!panelOpen} inert={!panelOpen}><div className="panel-heading"><strong>{({ templates: 'Start with an idea', elements: 'Shapes and images', text: 'Add text', projects: 'Saved on this device' })[panel]}</strong><button className="icon-button" aria-label="Close resource panel" onClick={() => setPanelOpen(false)}><Icon name="close" size={16} /></button></div><div className="resource-scroll">
        {panel === 'templates' && <><p className="help">Simple, editable starting points. Make them your own.</p><div className="template-grid">{TEMPLATES.map((template, index) => <button className="template-card" key={template.id} disabled={disabled} onClick={() => void newProject(template.id)}><span className={`template-preview template-${index}`} style={{ '--template-colour': template.accent } as React.CSSProperties}><i /><b>{template.id === 'blank' ? '+' : index === 2 ? 'A new\nperspective.' : index === 3 ? 'Make\nit yours.' : 'Big\nideas.'}</b><em /></span><strong>{template.name}</strong><span className="sr-only">{template.description}</span></button>)}</div></>}
        {panel === 'elements' && <><p className="help">Every shape is editable. Add your own images for a personal touch.</p><div className="shape-grid"><button disabled={visualBusy} onClick={() => add('rect')}><Icon name="square" size={44} /><span>Rectangle</span></button><button disabled={visualBusy} onClick={() => add('ellipse')}><Icon name="circle" size={44} /><span>Circle</span></button></div><button className="button full" disabled={disabled} onClick={() => imageInput.current?.click()}><Icon name="upload" />Upload images</button><p className="help">PNG, JPEG or WebP, up to 10 MB each. You can also drop images onto the canvas.</p></>}
        {panel === 'text' && <div className="text-presets">{[{ label: 'Add a heading', text: 'Your big idea', fontSize: 88, weight: 700 }, { label: 'Add a subheading', text: 'Make it yours', fontSize: 52, weight: 700 }, { label: 'Add body text', text: 'Tell your story here.', fontSize: 32, weight: 400 }].map((preset, index) => <button className={`text-preset text-preset-${index}`} key={preset.label} disabled={visualBusy} onClick={() => add('text', { text: preset.text, fontSize: preset.fontSize, fontWeight: preset.weight as 400 | 700, height: preset.fontSize * 2 })}>{preset.label}</button>)}<p className="help">Double-click text on the canvas to write. Use Edit for font, size and colour.</p></div>}
        {panel === 'projects' && <><label className="search-field"><Icon name="search" size={16} /><input placeholder="Find a local project" aria-label="Find a local project" value={query} onChange={event => setQuery(event.target.value)} /></label><button className="button full" disabled={disabled} onClick={() => fileInput.current?.click()}><Icon name="folder" />Open project file</button><div className="project-list">{projects.filter(item => item.title.toLowerCase().includes(query.toLowerCase())).map(item => <button className={`project-card ${item.id === project.id ? 'active' : ''}`} disabled={disabled} key={item.id} onClick={() => void openSaved(item.id)}><span className="project-symbol"><Icon name="image" size={24} /></span><strong>{item.title}</strong><small>{item.pageCount} pages · {item.width} × {item.height}<br />{new Date(item.updatedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</small></button>)}{!projects.length && <div className="empty-state"><Icon name="folder" size={30} /><strong>Your ideas live here</strong><p>Save a design to find it here next time.</p></div>}</div><p className="help local-note"><Icon name="device" size={16} />Browser storage can be cleared or evicted. Download project files for backups and transfers.</p></>}
      </div></aside>
      <main className="editing-area" aria-label="Design workspace">
        <div className="canvas-actions"><button className="icon-button" title="Edit properties" aria-label="Edit properties" aria-pressed={inspector && inspectorTab === 'edit'} onClick={() => showProperties('edit')}><Icon name="settings" /></button><button className="icon-button" title="Layers" aria-label="Layers" aria-pressed={inspector && inspectorTab === 'layers'} onClick={() => showProperties('layers')}><Icon name="layers" /></button></div>
        <div className={`canvas-stage ${viewport.handTool ? 'hand-tool' : ''} ${viewport.panning ? 'panning' : ''}`} ref={stage} inert={visualBusy || !ready || canvasFailed} aria-busy={visualBusy || !ready} tabIndex={0} role="region" aria-label="Design canvas. Hold Space and drag to pan. Control or Command and scroll to zoom." onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDrop={event => { if (event.dataTransfer.files.length) { event.preventDefault(); void addImages(event.dataTransfer.files); } }}>
          {selected && <div className="editor-context" role="toolbar" aria-label="Selected element controls">{selected.type === 'text' ? <><select aria-label="Quick font" value={selected.fontFamily} disabled={disabled || selected.locked} onChange={event => change({ fontFamily: event.target.value as DesignFont })}>{DESIGN_FONTS.map(font => <option key={font}>{font}</option>)}</select><NumberField label="Quick font size" value={selected.fontSize} min={6} max={512} disabled={disabled || selected.locked} onCommit={value => change({ fontSize: value })} /><button className="icon-button bold-button" aria-label="Bold" aria-pressed={selected.fontWeight === 700} disabled={disabled || selected.locked} onClick={() => change({ fontWeight: selected.fontWeight === 700 ? 400 : 700 })}>B</button></> : <span>{selected.type === 'image' ? 'Image' : selected.type === 'ellipse' ? 'Circle' : 'Rectangle'}</span>}{selected.type !== 'image' && <input type="color" aria-label="Quick colour" value={(selected.fill ?? '#7568ED').slice(0, 7)} disabled={disabled || selected.locked} onChange={event => change({ fill: event.target.value })} />}<button className="icon-button" aria-label="Duplicate selected element" title="Duplicate" disabled={disabled || selected.locked} onClick={duplicate}><Icon name="duplicate" size={17} /></button><button className="icon-button" aria-label="Delete selected element" title="Delete" disabled={disabled || selected.locked} onClick={remove}><Icon name="trash" size={17} /></button><button className="icon-button" aria-label="Align element" title="Align element" disabled={disabled || selected.locked || !selected.visible} onClick={showAlignment}><Icon name="align" size={17} /></button><button className="icon-button" aria-label="Snap guides" title="Snap to edges and centers (hold Alt to bypass)" aria-pressed={snapping} onClick={() => setSnapping(value => !value)}><Icon name="magnet" size={17} /></button><button className="icon-button" aria-label="More element properties" title="More properties" onClick={() => showProperties('edit')}><Icon name="settings" size={17} /></button></div>}
          <div className="canvas-paper" style={viewport.paperStyle}><canvas ref={canvasElement} aria-label={`${page.name}. Use Layers to select elements with the keyboard.`} />{alignmentGuides.length > 0 && <svg className="alignment-guides" aria-hidden="true" viewBox={`0 0 ${document.width} ${document.height}`} preserveAspectRatio="none">{alignmentGuides.map((guide, index) => { const line = guide.axis === 'x' ? { x1: guide.position, x2: guide.position, y1: guide.start, y2: guide.end } : { x1: guide.start, x2: guide.end, y1: guide.position, y2: guide.position }; return <g key={index}><line className="alignment-guide-halo" {...line} /><line className="alignment-guide-line" {...line} /></g>; })}</svg>}</div>{!ready && <div className="canvas-loading">Opening your creative space…</div>}
        </div>
        {showPages && <PageStrip document={document} pageIndex={pageIndex} canEdit disabled={visualBusy} onSelect={switchPage} onAdd={() => addPage()} onDuplicate={index => addPage(index)} onDelete={deletePage} onMove={movePage} />}
        <footer className="statusbar"><button className="page-details" disabled={disabled} onClick={() => showProperties('edit', true)} title="Page settings">{page.name}<span>{document.width} × {document.height} px</span></button><div className="viewport-controls"><button className="icon-button" title="Hand tool (H), or hold Space" aria-label="Hand tool" aria-pressed={viewport.handTool} onClick={() => { settleText(); viewport.setHandTool(!viewport.handTool); stage.current?.focus(); }}><Icon name="hand" /></button><input className="zoom-slider" type="range" min={2} max={400} value={Math.round(viewport.scale * 100)} aria-label="Zoom level" onChange={event => viewport.setZoom(event.target.value)} /><select aria-label="Canvas zoom" value={viewport.zoom} onChange={event => viewport.setZoom(event.target.value)}><option value="fit">{viewport.zoom === 'fit' ? `${Math.round(viewport.scale * 100)}%` : 'Fit'}</option>{viewport.zoom !== 'fit' && ![25, 50, 75, 100, 150, 200, 400].includes(Number(viewport.zoom)) && <option value={viewport.zoom}>{Math.round(viewport.scale * 100)}%</option>}{[25, 50, 75, 100, 150, 200, 400].map(value => <option key={value} value={value}>{value}%</option>)}</select><button className="icon-button" title="Fit canvas (Shift 1)" aria-label="Fit canvas" onClick={viewport.fit}><Icon name="expand" /></button><button className="pages-toggle" aria-pressed={showPages} onClick={() => setShowPages(value => !value)}><Icon name="layers" size={16} /><span>Pages</span><small>{pageIndex + 1} / {document.pages.length}</small></button><button className="icon-button" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts" onClick={() => shortcuts.current?.showModal()}><Icon name="keyboard" /></button></div></footer>
      </main>
      {inspector && <Inspector document={document} page={page} selected={selected} selectedId={selectedId} tab={inspectorTab} disabled={disabled} snapping={snapping} alignmentBusy={visualBusy} onSnapping={setSnapping} onAlign={alignElement} onTab={setInspectorTab} onClose={() => setInspector(false)} onSelect={select} onChange={change} onDuplicate={duplicate} onRemove={remove} onReorder={reorder} onPage={patch => { if (disabled) return; const next = copyDocument(capture()); Object.assign(next.pages[pageRef.current], patch); commit(next); }} onSize={(width, height) => { if (!disabled) commit({ ...capture(), width, height }); }} />}
    </div>
    <dialog className="shortcuts-dialog" ref={shortcuts}><div className="panel-heading"><strong>Make yourself at home</strong><button className="icon-button" aria-label="Close keyboard shortcuts" onClick={() => shortcuts.current?.close()}><Icon name="close" /></button></div><div className="shortcut-content"><p>Use Command on Mac in place of Ctrl.</p>{[['Save locally', 'Ctrl S'], ['Undo / redo', 'Ctrl Z / Ctrl Shift Z'], ['Duplicate', 'Ctrl D'], ['Delete selected element', 'Delete'], ['Move / move faster', 'Arrow / Shift Arrow'], ['Add text / rectangle / circle', 'T / R / O'], ['Hand / select tool', 'H / V'], ['Pan', 'Space + drag / middle mouse'], ['Zoom to pointer', 'Ctrl + scroll'], ['Bypass snapping', 'Alt + drag'], ['Zoom in / out', '+ / −'], ['Fit / actual size', 'Shift 1 / Shift 0'], ['Deselect / close panel', 'Esc']].map(([label, key]) => <div key={label}><span>{label}</span><kbd>{key}</kbd></div>)}<p>Insertion and arrow shortcuts apply while the canvas is focused. Shortcuts stay out of the way while you type.</p></div></dialog>
    <input className="sr-only" ref={imageInput} type="file" accept="image/png,image/jpeg,image/webp" multiple aria-label="Upload images" onChange={event => void addImages(event.target.files)} />
    <input className="sr-only" ref={fileInput} type="file" accept=".json,.design.json,application/json" aria-label="Open editable project" onChange={event => void openFile(event.target.files?.[0])} />
  </div>;
}
