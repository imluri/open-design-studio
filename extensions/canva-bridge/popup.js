const MAX_FILE_BYTES = 30 * 1024 * 1024;
const DEFAULT_EDITOR_URL = 'http://127.0.0.1:4480/';
const EDITOR_KEY = 'ods-import-editor-url';
const FILE_TYPES = {
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', zip: 'application/zip',
};
const byId = (id) => document.getElementById(id);
const downloadButton = byId('open-canva-download');
const transferButton = byId('create-transfer');
const fileInput = byId('export-file');
const editorInput = byId('editor-url');
const status = byId('status');
let working = false;
let canvaTabId;

function message(text, error = false) {
  status.textContent = text;
  status.dataset.error = String(error);
}

function editorUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Enter a valid editor address.');
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('Enter a full editor address, including https:// or http://.'); }
  const localhost = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || !(url.protocol === 'https:' || (url.protocol === 'http:' && localhost))) {
    throw new Error('Use an HTTPS address, or HTTP on localhost.');
  }
  url.search = '';
  url.hash = '';
  return url;
}

function selectedFile() {
  const file = fileInput.files?.[0];
  if (!file) throw new Error('Choose your downloaded Canva export first.');
  const extension = file.name.split('.').at(-1)?.toLowerCase();
  if (!extension || !Object.hasOwn(FILE_TYPES, extension)) throw new Error('Choose a PPTX, SVG, PNG, JPG, WebP or image ZIP file.');
  if (!file.size) throw new Error('This file is empty. Choose the completed download.');
  if (file.size > MAX_FILE_BYTES) throw new Error('The bridge supports files up to 30 MB. Import a larger original file directly in the editor, up to its 50 MB limit.');
  if (file.name.length > 240 || /[\u0000-\u001f\u007f/\\]/.test(file.name)) throw new Error('Rename this file using a name under 240 characters, without control characters or slashes.');
  return { file, mimeType: FILE_TYPES[extension] };
}

function setWorking(value) {
  working = value;
  fileInput.disabled = value;
  let validFile = false;
  try { selectedFile(); validFile = true; } catch { /* Keep invalid files disabled. */ }
  transferButton.disabled = value || !validFile;
  downloadButton.disabled = value || !Number.isInteger(canvaTabId);
}

try {
  editorInput.value = editorUrl(localStorage.getItem(EDITOR_KEY) || DEFAULT_EDITOR_URL).href;
} catch {
  editorInput.value = DEFAULT_EDITOR_URL;
}

chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  let url;
  try { url = new URL(tab?.url || ''); } catch { /* A protected or unavailable tab needs manual guidance. */ }
  if (url && ['www.canva.com', 'canva.com'].includes(url.hostname) && /^\/design\/[^/]+\//.test(url.pathname) && Number.isInteger(tab.id)) {
    canvaTabId = tab.id;
    byId('canva-state').textContent = 'Your active Canva design is ready.';
    downloadButton.disabled = false;
  } else {
    byId('canva-state').textContent = 'Open a Canva design tab to use the download helper. You can prepare an existing export below.';
  }
}).catch(() => {
  byId('canva-state').textContent = 'Open a Canva design and choose Share → Download. You can prepare an existing export below.';
});

downloadButton.addEventListener('click', async () => {
  if (working || !Number.isInteger(canvaTabId)) return;
  setWorking(true);
  message('Opening Canva’s download options…');
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: canvaTabId },
      func: async () => {
        if (!['www.canva.com', 'canva.com'].includes(location.hostname) || !/^\/design\/[^/]+\//.test(location.pathname)) return 'not-design';
        const visible = (element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          if (!(rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && element.getAttribute('aria-disabled') !== 'true' && !element.disabled)) return false;
          const hit = document.elementFromPoint(Math.max(0, Math.min(innerWidth - 1, rect.x + rect.width / 2)), Math.max(0, Math.min(innerHeight - 1, rect.y + rect.height / 2)));
          return hit === element || element.contains(hit);
        };
        const label = (element) => (element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent || '').replace(/\s+/g, ' ').trim();
        const shareName = /^(share(?: this design| design)?|kongsi|分享|பகிர்)$/i;
        const downloadName = /^(download|muat turun|下载|பதிவிறக்கு)(?:\s*↓)?$/i;
        const controls = () => [...document.querySelectorAll('button,[role="button"],[role="menuitem"]')].filter(visible);
        // Only follow the visible Share > Download controls. Never inspect account data,
        // private endpoints, editor internals, cookies, or the design's hidden layers.
        // A pre-existing Download button may confirm a download. Only click a newly
        // revealed menu item, so an already open download dialog cannot be submitted.
        const existingDownloads = new Set(controls().filter((element) => downloadName.test(label(element))));
        const share = controls().find((element) => shareName.test(label(element)));
        if (!share) return 'manual';
        share.click();
        const deadline = Date.now() + 1800;
        while (Date.now() < deadline) {
          const download = controls().find((element) => !existingDownloads.has(element) && downloadName.test(label(element)));
          if (download) {
            download.click();
            return 'opened';
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return 'share-opened';
      },
    });
    const result = results[0]?.result;
    if (result === 'opened') message('Download options opened. Choose a format and confirm your download in Canva.');
    else if (result === 'share-opened') message('The Share menu is open. Choose Download, select your format, and confirm in Canva.');
    else message('Use Share → Download in Canva. The helper could not find its controls in this layout or language.');
  } catch {
    message('The browser could not open Canva’s menu. Use Share → Download in the design, then choose your downloaded file below.', true);
  } finally {
    setWorking(false);
  }
});

fileInput.addEventListener('change', () => {
  try {
    const { file } = selectedFile();
    byId('file-summary').textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB`;
    transferButton.disabled = false;
    message('Ready to create a local transfer file.');
  } catch (error) {
    transferButton.disabled = true;
    byId('file-summary').textContent = 'PPTX, SVG, PNG, JPG, WebP or image ZIP. Up to 30 MB.';
    if (fileInput.files?.length) message(error.message, true);
  }
});

transferButton.addEventListener('click', async () => {
  if (working) return;
  let objectUrl;
  try {
    const { file, mimeType } = selectedFile();
    setWorking(true);
    message('Preparing the transfer file on your device…');
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Could not read this file. Choose it again.'));
      reader.onabort = () => reject(new Error('File preparation was cancelled.'));
      reader.readAsDataURL(file);
    });
    if (typeof dataUrl !== 'string' || !dataUrl.includes(';base64,')) throw new Error('Could not prepare this file. Import the original export directly in the editor.');
    const data = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const envelope = { format: 'open-design-studio-canva-transfer', version: 1, name: file.name, mimeType, data };
    objectUrl = URL.createObjectURL(new Blob([JSON.stringify(envelope)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = `${file.name.replace(/\.[^.]+$/, '').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '-').slice(0, 150) || 'canva-export'}.canva-import.json`;
    document.body.append(link);
    link.click();
    link.remove();
    message('Transfer download started. Open the editor below, then choose the .canva-import.json file in its import dialog.');
  } catch (error) {
    message(error instanceof Error ? error.message : 'Could not prepare this file. Import the original export directly in the editor.', true);
  } finally {
    if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
    setWorking(false);
  }
});

byId('save-url').addEventListener('click', () => {
  try {
    const url = editorUrl(editorInput.value);
    localStorage.setItem(EDITOR_KEY, url.href);
    editorInput.value = url.href;
    message('Editor address saved on this device.');
  } catch (error) {
    message(error instanceof Error ? error.message : 'Could not save this editor address.', true);
  }
});

byId('open-editor').addEventListener('click', async () => {
  try {
    const url = editorUrl(editorInput.value);
    url.searchParams.set('import', 'canva');
    await chrome.tabs.create({ url: url.href });
  } catch (error) {
    message(error instanceof Error ? error.message : 'Could not open the editor.', true);
  }
});
