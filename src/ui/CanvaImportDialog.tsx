import { useEffect, useRef, useState } from 'react';
import type { Project } from '../core/model';
import { exportPage } from '../core/canvas';
import type { CanvaImportResult } from '../core/canva/importer';
import Icon from './Icon';

export default function CanvaImportDialog({ onClose, onImport }: { onClose: () => void; onImport: (project: Project) => Promise<boolean> }) {
  const dialog = useRef<HTMLDialogElement>(null), input = useRef<HTMLInputElement>(null), generation = useRef(0);
  const [result, setResult] = useState<CanvaImportResult | null>(null), [preview, setPreview] = useState('');
  const [busy, setBusy] = useState(''), [error, setError] = useState('');
  useEffect(() => { dialog.current?.showModal(); return () => { generation.current++; }; }, []);
  useEffect(() => {
    if (!result) { setPreview(''); return; }
    let cancelled = false, url = '';
    void exportPage(result.project.document, 0, 'png').then(blob => {
      if (cancelled) return;
      url = URL.createObjectURL(blob); setPreview(url);
    }).catch(() => { if (!cancelled) setPreview(''); });
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [result]);
  async function choose(files: FileList | null) {
    if (!files?.length || busy) return;
    const version = ++generation.current;
    setBusy('Reading export…'); setError(''); setResult(null);
    try {
      const { importCanvaFiles } = await import('../core/canva/importer');
      const imported = await importCanvaFiles(Array.from(files));
      if (version === generation.current) setResult(imported);
    } catch (caught) { if (version === generation.current) setError(caught instanceof Error ? caught.message : 'This export could not be imported.'); }
    finally { if (version === generation.current) { setBusy(''); if (input.current) input.current.value = ''; } }
  }
  async function apply() {
    if (!result || busy) return;
    setBusy('Importing design…'); setError('');
    try { if (await onImport(result.project)) onClose(); else setError('The current design could not be saved. Download a backup before trying again.'); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'This design could not be imported.'); }
    finally { setBusy(''); }
  }
  return <dialog className="canva-import-dialog" ref={dialog} onCancel={event => { if (busy === 'Importing design…') { event.preventDefault(); return; } generation.current++; onClose(); }} onClose={onClose} aria-labelledby="canva-import-heading">
    <div className="panel-heading"><div><span className="menu-label">Local file transfer</span><strong id="canva-import-heading">Import from Canva</strong></div><button className="icon-button" aria-label="Close Canva import" onClick={onClose} disabled={busy === 'Importing design…'}><Icon name="close" /></button></div>
    <div className="canva-import-content">
      {!result && <><p className="canva-intro">Download your design from Canva, then bring the export here.</p>
      <div className="canva-format-list"><p><strong>PPTX</strong><span>Presentation text and basic shapes can stay editable.</span></p><p><strong>SVG</strong><span>Simple shapes and text can stay editable. Complex artwork may become an image.</span></p><p><strong>PNG / JPG / ZIP</strong><span>Image pages keep their appearance. Text inside them stays part of the image.</span></p></div></>}
      <div className="canva-import-actions"><button className="button primary" onClick={() => input.current?.click()} disabled={Boolean(busy)}><Icon name="upload" size={17} />{result ? 'Choose another export' : 'Choose Canva export'}</button><a className="button" href="./canva-bridge.zip" download><Icon name="download" size={16} />Chromium extension</a></div>
      <p className="help">In Canva: Share → Download. Choose a supported format available for your design. You can also select a .canva-import.json transfer from the extension.</p>
      {!result && <details className="canva-bridge-help"><summary>Set up the extension</summary><p className="help">Download the Chromium extension above and extract the ZIP. Open chrome://extensions, brave://extensions or edge://extensions, enable Developer mode, then choose Load unpacked and select the canva-bridge folder. In a Canva design, use the extension button to open download options and prepare your exported file.</p></details>}
      {busy && <p className="import-progress" role="status">{busy}</p>}
      {error && <p className="import-error" role="alert">{error}</p>}
      {result && <section className="canva-import-result" aria-label="Canva import preview"><div className="canva-import-preview">{preview ? <img src={preview} alt="Preview of the first imported page" /> : <Icon name="image" size={40} />}</div><div className="canva-import-report"><h3>{result.project.title}</h3><p>{result.summary.pages} {result.summary.pages === 1 ? 'page' : 'pages'} · {result.project.document.width} × {result.project.document.height} px</p><dl><div><dt>Editable text and shapes</dt><dd>{result.summary.editableElements}</dd></div><div><dt>Image layers</dt><dd>{result.summary.imageElements}</dd></div></dl>{result.summary.warnings.length > 0 && <details open><summary>Import notes ({result.summary.warnings.length})</summary><ul>{result.summary.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}</div></section>}
    </div>
    <div className="canva-import-footer"><span className="help">Files are processed on this device.</span><button className="button" onClick={onClose} disabled={busy === 'Importing design…'}>Cancel</button><button className="button primary" disabled={!result || Boolean(busy)} onClick={() => void apply()}>Import {result ? `${result.summary.pages} ${result.summary.pages === 1 ? 'page' : 'pages'}` : 'design'}</button></div>
    <input ref={input} className="sr-only" type="file" aria-label="Canva export files" multiple accept=".pptx,.svg,.png,.jpg,.jpeg,.webp,.zip,.canva-import.json,application/json" onChange={event => void choose(event.target.files)} />
  </dialog>;
}
