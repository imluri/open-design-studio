import { DESIGN_MAX_PAGES, DESIGN_TITLE_MAX, validateProject } from './model';
import type { Project, ProjectSummary } from './model';

const DATABASE_NAME = 'open-design-studio';
const DATABASE_VERSION = 1;
const PROJECTS = 'projects';
const SUMMARIES = 'projectSummaries';
type StorageErrorCode = 'unavailable' | 'blocked' | 'quota_exceeded' | 'corrupt' | 'operation_failed';
const MESSAGES: Record<StorageErrorCode, string> = {
  unavailable: 'Browser storage is unavailable. Allow site storage, or download your project to keep a copy.',
  blocked: 'Another tab is holding the project library open. Close other editor tabs and try again.',
  quota_exceeded: 'Your browser storage is full. Download a project backup before freeing browser storage, so your design stays safe.',
  corrupt: 'A saved project could not be read. Import a downloaded project backup to recover your work.',
  operation_failed: 'The browser could not save or open the project library. Keep this tab open and download a project backup before reloading.',
};

export class ProjectStorageError extends Error {
  readonly code: StorageErrorCode;
  constructor(code: StorageErrorCode) { super(MESSAGES[code]); this.name = 'ProjectStorageError'; this.code = code; }
}

const storageError = (error: unknown): ProjectStorageError => {
  if (error instanceof ProjectStorageError) return error;
  const name = error && typeof error === 'object' && 'name' in error ? error.name : '';
  if (name === 'QuotaExceededError') return new ProjectStorageError('quota_exceeded');
  if (name === 'SecurityError' || name === 'NotAllowedError') return new ProjectStorageError('unavailable');
  return new ProjectStorageError('operation_failed');
};
let databasePromise: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => { if (!settled) { settled = true; reject(storageError(error)); } };
    let request: IDBOpenDBRequest;
    try {
      if (!globalThis.indexedDB) { fail(new ProjectStorageError('unavailable')); return; }
      request = globalThis.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    } catch (error) { fail(error); return; }
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(PROJECTS)) database.createObjectStore(PROJECTS, { keyPath: 'id' });
      if (!database.objectStoreNames.contains(SUMMARIES)) database.createObjectStore(SUMMARIES, { keyPath: 'id' });
    };
    request.onblocked = () => fail(new ProjectStorageError('blocked'));
    request.onerror = () => fail(request.error);
    request.onsuccess = () => {
      const database = request.result;
      // A blocked opening can succeed after its caller has already been told to retry.
      if (settled) { database.close(); return; }
      if (!database.objectStoreNames.contains(PROJECTS) || !database.objectStoreNames.contains(SUMMARIES)) {
        database.close(); fail(new ProjectStorageError('corrupt')); return;
      }
      database.onversionchange = () => { database.close(); if (databasePromise === pending) databasePromise = undefined; };
      database.onclose = () => { if (databasePromise === pending) databasePromise = undefined; };
      settled = true; resolve(database);
    };
  });
  databasePromise = pending;
  void pending.catch(() => { if (databasePromise === pending) databasePromise = undefined; });
  return pending;
}

/** Resolve only after the native transaction commits, never after put() merely succeeds. */
async function transact<T>(stores: string[], mode: IDBTransactionMode, operation: (transaction: IDBTransaction, result: (value: T) => void, fail: (error: unknown) => void) => void): Promise<T> {
  const database = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    let transaction: IDBTransaction;
    try { transaction = database.transaction(stores, mode); }
    catch (error) { database.close(); databasePromise = undefined; reject(storageError(error)); return; }
    let value: T | undefined, hasValue = false, failure: unknown;
    const fail = (error: unknown) => {
      failure = error;
      try { transaction.abort(); } catch { reject(storageError(error)); }
    };
    transaction.oncomplete = () => hasValue ? resolve(value as T) : reject(new ProjectStorageError('operation_failed'));
    transaction.onabort = () => reject(storageError(failure ?? transaction.error));
    transaction.onerror = () => { failure ??= transaction.error; };
    try { operation(transaction, next => { value = next; hasValue = true; }, fail); }
    catch (error) { fail(error); }
  });
}

function projectId(value: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value)) throw new ProjectStorageError('corrupt');
  return value;
}
const summary = (project: Project): ProjectSummary => ({
  id: project.id, title: project.title, createdAt: project.createdAt, updatedAt: project.updatedAt,
  width: project.document.width, height: project.document.height, pageCount: project.document.pages.length,
});
function readSummary(value: unknown): ProjectSummary {
  const invalid = (): never => { throw new ProjectStorageError('corrupt'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== 7 || !['id', 'title', 'createdAt', 'updatedAt', 'width', 'height', 'pageCount'].every(key => Object.hasOwn(item, key))) return invalid();
  const date = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  const whole = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
  if (typeof item.id !== 'string' || typeof item.title !== 'string' || !item.title.trim() || item.title.length > DESIGN_TITLE_MAX || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(item.title) || !date(item.createdAt) || !date(item.updatedAt) || item.updatedAt < item.createdAt || !whole(item.width, 320, 4096) || !whole(item.height, 320, 4096) || !whole(item.pageCount, 1, DESIGN_MAX_PAGES)) return invalid();
  return { id: projectId(item.id), title: item.title, createdAt: item.createdAt, updatedAt: item.updatedAt, width: item.width, height: item.height, pageCount: item.pageCount };
}

/** Metadata lives separately so opening the library does not read every embedded image. */
export async function listProjects(): Promise<ProjectSummary[]> {
  return transact<ProjectSummary[]>([SUMMARIES], 'readonly', (transaction, done, fail) => {
    const request = transaction.objectStore(SUMMARIES).getAll();
    request.onsuccess = () => {
      try {
        const projects = (request.result as unknown[]).map(readSummary);
        projects.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
        done(projects);
      } catch (error) { fail(error); }
    };
  });
}

export async function getProject(id: string): Promise<Project | null> {
  const key = projectId(id);
  return transact<Project | null>([PROJECTS], 'readonly', (transaction, done, fail) => {
    const request = transaction.objectStore(PROJECTS).get(key);
    request.onsuccess = () => {
      if (request.result === undefined) { done(null); return; }
      try { done(validateProject(request.result)); }
      catch { fail(new ProjectStorageError('corrupt')); }
    };
  });
}

/** The UI owns updatedAt and write ordering. This boundary preserves its validated timestamp. */
export async function saveProject(value: Project): Promise<Project> {
  const project = validateProject(value);
  return transact<Project>([PROJECTS, SUMMARIES], 'readwrite', (transaction, done) => {
    transaction.objectStore(PROJECTS).put(project);
    transaction.objectStore(SUMMARIES).put(summary(project));
    done(project);
  });
}

export async function deleteProject(id: string): Promise<void> {
  const key = projectId(id);
  return transact<void>([PROJECTS, SUMMARIES], 'readwrite', (transaction, done) => {
    transaction.objectStore(PROJECTS).delete(key);
    transaction.objectStore(SUMMARIES).delete(key);
    done(undefined);
  });
}
