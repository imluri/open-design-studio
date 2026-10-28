import { validateProject } from './model';
import type { DesignElement, DesignElementBase, DesignPage, Project } from './model';

/** Original, neutral layouts made only from text and geometric shapes. No bundled brand assets. */
export const TEMPLATES = [
  { id: 'blank', name: 'Blank canvas', description: 'Start with a clean portrait canvas.', accent: '#eef1f5' },
  { id: 'bold-announcement', name: 'Bold announcement', description: 'Large type and playful colour for something worth sharing.', accent: '#ff795f' },
  { id: 'editorial-feature', name: 'Editorial feature', description: 'A square layout with a calm, considered rhythm.', accent: '#e6dcca' },
  { id: 'colour-story', name: 'Colour story', description: 'A bright, tall story with room for your next idea.', accent: '#b7a4ff' },
] as const;

const id = (): string => crypto.randomUUID();
const base = (name: string, x: number, y: number, width: number, height: number): DesignElementBase => ({
  id: id(), name, x, y, width, height, rotation: 0, opacity: 1, locked: false, visible: true,
});
const shape = (name: string, type: 'rect' | 'ellipse', fill: string, x: number, y: number, width: number, height: number): DesignElement => ({ ...base(name, x, y, width, height), type, fill });
const label = (name: string, text: string, fill: string, fontSize: number, x: number, y: number, width: number, height: number, options: { fontFamily?: 'Arial' | 'Georgia'; fontWeight?: 400 | 700; letterSpacing?: number } = {}): DesignElement => ({
  ...base(name, x, y, width, height), type: 'text', text, fill, fontSize,
  fontFamily: options.fontFamily ?? 'Arial', fontWeight: options.fontWeight ?? 700,
  textAlign: 'left', ...(options.letterSpacing === undefined ? {} : { letterSpacing: options.letterSpacing }),
});

/** Every call creates fresh project, page and element IDs. The default is genuinely blank. */
export function createProject(templateId = 'blank'): Project {
  const template = TEMPLATES.find(item => item.id === templateId);
  if (!template) throw new Error('Choose an available template.');
  let width = 1080, height = 1350;
  const page: DesignPage = { id: id(), name: 'Page 1', background: '#ffffff', elements: [] };
  if (templateId === 'bold-announcement') {
    page.background = '#18243b';
    page.elements = [
      shape('Coral panel', 'rect', '#ff795f', 650, 0, 430, 1350),
      shape('Lime circle', 'ellipse', '#d5f282', 730, 780, 480, 480),
      shape('Ivory accent', 'rect', '#fff9ed', 70, 235, 88, 12),
      label('Your name', 'YOUR NAME', '#fff9ed', 25, 70, 70, 530, 60, { letterSpacing: 4 }),
      label('Headline', 'Make\nsomething\nworth sharing.', '#fff9ed', 108, 65, 310, 890, 490),
      label('Supporting text', 'A little space for your big idea.', '#fff9ed', 31, 70, 885, 600, 110, { fontWeight: 400 }),
      label('Footer', 'START WITH AN IDEA. MAKE IT YOURS.', '#fff9ed', 21, 70, 1210, 850, 80, { letterSpacing: 2 }),
    ];
  } else if (templateId === 'editorial-feature') {
    width = 1080; height = 1080; page.background = '#f3ede2';
    page.elements = [
      shape('Fine rule', 'rect', '#243329', 70, 165, 940, 3),
      shape('Green field', 'rect', '#b6cbb0', 660, 235, 350, 620),
      shape('Ochre circle', 'ellipse', '#dfaa59', 725, 350, 360, 360),
      label('Kicker', 'THE IDEA JOURNAL', '#243329', 23, 70, 78, 900, 70, { letterSpacing: 4 }),
      label('Headline', 'Fresh ideas.\nNew perspectives.', '#243329', 77, 65, 245, 610, 390, { fontFamily: 'Georgia', fontWeight: 400 }),
      label('Supporting text', 'Good things begin with a different point of view.', '#243329', 29, 70, 705, 520, 145, { fontWeight: 400 }),
      label('Footer', 'YOUR STORY, YOUR WAY', '#243329', 22, 70, 947, 900, 65, { letterSpacing: 3 }),
    ];
  } else if (templateId === 'colour-story') {
    height = 1920; page.background = '#e8ddff';
    page.elements = [
      shape('Orange field', 'rect', '#ff9655', 0, 1290, 1080, 630),
      shape('Violet circle', 'ellipse', '#7763db', 630, 120, 600, 600),
      shape('Cream disc', 'ellipse', '#fff9e9', -130, 1050, 520, 520),
      label('Kicker', 'MAKE ROOM FOR WHAT’S NEXT', '#30234a', 26, 80, 95, 900, 105, { letterSpacing: 3 }),
      label('Headline', 'Small steps.\nBold moves.', '#30234a', 128, 70, 565, 940, 410),
      label('Supporting text', 'Take your next idea\none step further.', '#30234a', 43, 80, 1115, 820, 155, { fontWeight: 400 }),
      label('Closing line', 'Your next chapter\nstarts here.', '#30234a', 72, 80, 1530, 900, 230),
    ];
  }
  const now = new Date().toISOString();
  return validateProject({ id: id(), title: templateId === 'blank' ? 'Untitled design' : template.name, createdAt: now, updatedAt: now,
    document: { format: 'open-design-studio', version: 1, width, height, pages: [page] } });
}
