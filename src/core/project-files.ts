import { PROJECT_MAX_FILE_BYTES, validateProject } from './model';
import type { Project } from './model';

export const PROJECT_FILE_EXTENSION = '.design.json';

export class ProjectFileError extends Error {
  constructor(message: string) { super(message); this.name = 'ProjectFileError'; }
}

/** A native backup includes embedded raster assets and can be opened without a server. */
export function projectBlob(value: Project): Blob {
  const project = validateProject(value);
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
  if (blob.size > PROJECT_MAX_FILE_BYTES) throw new ProjectFileError('Project files must be smaller than 50 MB. Remove unused images or pages before downloading.');
  return blob;
}

/** Filename and MIME type are advisory: only the bounded JSON schema decides what is accepted. */
export async function parseProjectFile(file: File): Promise<Project> {
  if (!file.size || file.size > PROJECT_MAX_FILE_BYTES) throw new ProjectFileError('Choose a non-empty .design.json project file smaller than 50 MB.');
  let source: string;
  try { source = await file.text(); }
  catch { throw new ProjectFileError('The project file could not be read. Try downloading or selecting it again.'); }
  if (new TextEncoder().encode(source).byteLength > PROJECT_MAX_FILE_BYTES) throw new ProjectFileError('Project files must be smaller than 50 MB.');
  let value: unknown;
  try { value = JSON.parse(source); }
  catch { throw new ProjectFileError('This file is not valid project JSON. Choose a .design.json backup from Open Design Studio.'); }
  return validateProject(value);
}
