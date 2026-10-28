import { useEffect, useRef, useState } from 'react';
import { DESIGN_FONTS, type DesignDocument, type DesignElement, type DesignElementBase, type DesignFont, type DesignPage } from '../core/model';
import Icon from './Icon';

export type ElementPatch = Partial<DesignElementBase> & { fill?: string; text?: string; fontSize?: number; fontFamily?: DesignFont; fontWeight?: 400 | 700; textAlign?: 'left' | 'center' | 'right'; letterSpacing?: number; borderRadius?: number };
export function NumberField({ value, min, max, step = 1, disabled, onCommit, label }: { value: number; min: number; max: number; step?: number; disabled?: boolean; onCommit: (value: number) => void; label?: string }) {
  const [draft, setDraft] = useState(String(value));
  const focused = useRef(false), skipBlur = useRef(false);
  useEffect(() => { if (!focused.current) setDraft(String(value)); }, [value]);
  const commit = () => {
    const number = draft.trim() ? Number(draft) : NaN;
    if (!Number.isFinite(number)) { setDraft(String(value)); return; }
    const next = Math.max(min, Math.min(max, number)); setDraft(String(next));
    if (next !== value) onCommit(next);
  };
  return <input aria-label={label} type="number" value={draft} min={min} max={max} step={step} disabled={disabled}
    onChange={event => setDraft(event.target.value)} onFocus={() => { focused.current = true; skipBlur.current = false; }}
    onBlur={() => { focused.current = false; if (!skipBlur.current) commit(); skipBlur.current = false; }}
    onKeyDown={event => { if (event.key === 'Enter' || event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); skipBlur.current = true; if (event.key === 'Enter') commit(); else setDraft(String(value)); event.currentTarget.blur(); } }} />;
}

interface Props {
  document: DesignDocument; page: DesignPage; selected?: DesignElement; selectedId: string | null;
  tab: 'edit' | 'layers'; disabled: boolean;
  onTab: (tab: 'edit' | 'layers') => void; onClose: () => void; onSelect: (id: string | null) => void;
  onChange: (patch: ElementPatch, id?: string) => void; onDuplicate: () => void; onRemove: () => void; onReorder: (direction: number) => void;
  onPage: (patch: Partial<Pick<DesignPage, 'name' | 'background'>>) => void;
  onSize: (width: number, height: number) => void;
}
const PALETTE = ['#7568ED', '#171A23', '#FFFFFF', '#C9BFFF', '#FF957A', '#FFE477', '#CBE99C', '#087F8C'];

export default function Inspector({ document, page, selected, selectedId, tab, disabled, onTab, onClose, onSelect, onChange, onDuplicate, onRemove, onReorder, onPage, onSize }: Props) {
  const editable = !disabled && !selected?.locked;
  return <aside className="inspector" aria-label="Properties and layers">
    <div className="panel-heading"><strong>{tab === 'layers' ? 'Layers' : selected ? 'Edit element' : 'Page settings'}</strong><button className="icon-button" onClick={onClose} aria-label="Close properties"><Icon name="close" /></button></div>
    <div className="panel-tabs" role="group" aria-label="Inspector view"><button aria-pressed={tab === 'edit'} onClick={() => onTab('edit')}><Icon name="settings" size={16} />Edit</button><button aria-pressed={tab === 'layers'} onClick={() => onTab('layers')}><Icon name="layers" size={16} />Layers <small>{page.elements.length}</small></button></div>
    {tab === 'layers' ? <div className="layers-list"><p className="help">Front to back. Select a layer to edit it.</p>{[...page.elements].reverse().map(element => <div className={`layer-row ${element.id === selectedId ? 'selected' : ''}`} key={element.id}><button className="layer-select" disabled={disabled} onClick={() => { onSelect(element.id); onTab('edit'); }}><span className="layer-thumb">{element.type === 'image' ? <img src={element.src} alt="" /> : <Icon name={element.type === 'text' ? 'text' : element.type === 'ellipse' ? 'circle' : 'square'} />}</span><span>{element.name || 'Untitled layer'}<small>{element.type}</small></span>{element.locked && <Icon name="lock" size={13} />}</button><button className="icon-button" title={element.visible ? 'Hide layer' : 'Show layer'} aria-label={`${element.visible ? 'Hide' : 'Show'} ${element.name}`} disabled={disabled} onClick={() => onChange({ visible: !element.visible }, element.id)}><Icon name={element.visible ? 'eye' : 'hidden'} size={16} /></button></div>)}{!page.elements.length && <div className="empty-state"><Icon name="layers" size={28} /><strong>No layers yet</strong><p>Add text, a shape or an image.</p></div>}</div> : <div className="properties" key={selected?.id ?? page.id}>
      {selected ? <>
        <label>Layer name<input value={selected.name} maxLength={160} placeholder="For example: Main headline" disabled={disabled} onChange={event => onChange({ name: event.target.value })} /></label>
        <div className="action-row"><button className="icon-button" aria-label={selected.locked ? 'Unlock element' : 'Lock element'} title={selected.locked ? 'Unlock element' : 'Lock element'} disabled={disabled} onClick={() => onChange({ locked: !selected.locked })}><Icon name={selected.locked ? 'lock' : 'unlock'} /></button><button className="icon-button" title="Duplicate element" aria-label="Duplicate element" disabled={!editable} onClick={onDuplicate}><Icon name="duplicate" /></button><button className="icon-button" title="Bring forward" aria-label="Bring forward" disabled={!editable} onClick={() => onReorder(1)}><Icon name="up" /></button><button className="icon-button" title="Send backward" aria-label="Send backward" disabled={!editable} onClick={() => onReorder(-1)}><Icon name="down" /></button><button className="icon-button danger" title="Delete element" aria-label="Delete element" disabled={!editable} onClick={onRemove}><Icon name="trash" /></button></div>
        {selected.locked && <p className="help">Unlock this layer to change its appearance or position.</p>}
        {selected.type === 'text' && <>
          <label>Text<textarea value={selected.text} maxLength={5000} rows={3} placeholder="Write your message…" disabled={!editable} onChange={event => onChange({ text: event.target.value })} /></label>
          <label>Font<select value={selected.fontFamily} disabled={!editable} onChange={event => onChange({ fontFamily: event.target.value as DesignFont })}>{DESIGN_FONTS.map(font => <option key={font}>{font}</option>)}</select></label>
          <div className="property-grid"><label>Font size<NumberField value={selected.fontSize} min={6} max={512} disabled={!editable} onCommit={value => onChange({ fontSize: value })} /></label><label>Weight<select value={selected.fontWeight} disabled={!editable} onChange={event => onChange({ fontWeight: Number(event.target.value) as 400 | 700 })}><option value={400}>Regular</option><option value={700}>Bold</option></select></label></div>
          <div className="property-grid"><label>Alignment<select value={selected.textAlign} disabled={!editable} onChange={event => onChange({ textAlign: event.target.value as 'left' | 'center' | 'right' })}><option value="left">Left</option><option value="center">Centre</option><option value="right">Right</option></select></label><label>Letter spacing<NumberField value={selected.letterSpacing ?? 0} min={-10} max={100} step={0.1} disabled={!editable} onCommit={value => onChange({ letterSpacing: value })} /></label></div>
        </>}
        {selected.type !== 'image' && <label>Colour<div className="colour-field"><input type="color" aria-label="Element colour" value={(selected.fill ?? '#7568ED').slice(0, 7)} disabled={!editable} onChange={event => onChange({ fill: event.target.value })} /><span>{selected.fill}</span></div></label>}
        {selected.type === 'rect' && <label>Corner radius<NumberField value={selected.borderRadius ?? 0} min={0} max={2048} disabled={!editable} onCommit={value => onChange({ borderRadius: value })} /></label>}
        <details><summary>Position and size</summary><div className="property-grid details-body">{(['x', 'y', 'width', 'height', 'rotation'] as const).map(key => <label key={key}>{({ x: 'X', y: 'Y', width: 'Width', height: 'Height', rotation: 'Rotation' })[key]}<NumberField value={Math.round(selected[key])} min={key === 'width' || key === 'height' ? 1 : key === 'rotation' ? -360 : -16384} max={key === 'rotation' ? 360 : 16384} disabled={!editable} onCommit={value => onChange({ [key]: value })} /></label>)}<label>Opacity %<NumberField value={Math.round(selected.opacity * 100)} min={0} max={100} disabled={!editable} onCommit={value => onChange({ opacity: value / 100 })} /></label></div></details>
        <button className="button" disabled={disabled} onClick={() => onSelect(null)}>Page settings</button>
      </> : <>
        <div className="empty-state compact"><Icon name="square" size={26} /><strong>Your canvas, your ideas</strong><p>Select an element to edit its properties.</p></div>
        <label>Page name<input value={page.name} maxLength={160} placeholder="For example: Introduction" disabled={disabled} onChange={event => onPage({ name: event.target.value })} /></label>
        <label>Background<div className="colour-field"><input type="color" aria-label="Page background" value={page.background.slice(0, 7)} disabled={disabled} onChange={event => onPage({ background: event.target.value })} /><span>{page.background}</span></div></label>
        <div className="property-grid"><label>Width<NumberField value={document.width} min={320} max={4096} disabled={disabled} onCommit={value => onSize(Math.round(value), document.height)} /></label><label>Height<NumberField value={document.height} min={320} max={4096} disabled={disabled} onCommit={value => onSize(document.width, Math.round(value))} /></label></div>
        <div className="size-presets">{[{ label: 'Portrait', w: 1080, h: 1350 }, { label: 'Square', w: 1080, h: 1080 }, { label: 'Story', w: 1080, h: 1920 }].map(size => <button className="button" key={size.label} disabled={disabled} onClick={() => onSize(size.w, size.h)}>{size.label}</button>)}</div>
        <p className="help">Resizing changes the canvas boundary. Elements keep their position and size.</p>
      </>}
      {selected?.type !== 'image' && <div className="palette"><span>Quick colours</span><div>{PALETTE.map(colour => <button key={colour} style={{ background: colour }} aria-label={`Use ${colour}`} title={colour} disabled={!editable} onClick={() => selected ? onChange({ fill: colour }) : onPage({ background: colour })} />)}</div></div>}
    </div>}
  </aside>;
}
