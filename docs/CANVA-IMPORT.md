# Importing designs from Canva

Open Design Studio imports files that you download from Canva. You can use the editor's **Import from Canva** dialog directly, or install the optional Chromium import bridge to help prepare the file.

This is an independent open source feature. It is not affiliated with, endorsed by, or provided by Canva.

## Quick start without an extension

1. Open your design in Canva.
2. Choose **Share → Download**, select a supported format, and confirm your download.
3. Open Open Design Studio and choose **Import from Canva**. Opening the editor with `?import=canva` also opens this dialog.
4. Choose your downloaded file and review the import result before editing.
5. Save an editable `.design.json` backup after importing.

The original Canva design remains separate. Editing in Open Design Studio does not update it.

## Choosing a format

| Format | What to expect |
| --- | --- |
| PPTX | For Canva presentations. The importer can recover supported text, shapes and images; unsupported features may not match the original. |
| SVG | For static designs. Supported content can become editable elements. Complex artwork, effects and text represented as outlines cannot be assumed to become editable text. |
| PNG, JPG or WebP | A movable image of the exported page. These formats do not contain the original text or shape layers. |
| Image ZIP | Multiple exported image pages, imported in file-name order. |

Canva's available download options depend on the design and plan. Canva documents PPTX as a presentation-only format and warns that exported fonts and layout can differ. See its [download file types guide](https://www.canva.com/help/download-file-types/).

Check the editor's import report. A file exported from Canva does not guarantee a complete, editable copy of every original layer, font, effect, animation, chart or video.

### Import limits

Choose one presentation, ZIP or transfer file, or up to 12 image/SVG files. Direct selections total at most 50 MB. Each SVG and embedded image must be under 10 MB; the final project supports at most 12 pages, 150 elements per page, 1,000 elements overall and 30 MB of distinct embedded images. Pages fit a canvas between 320 and 4,096 pixels per side. ZIP archives are checked against declared sizes, actual expanded sizes and checksums, with a 64 MB expanded limit and a 12 MB entry limit (4 MB for XML).

Scripts, external resources, encrypted archives and unsupported image types are rejected. SVG effects, clipping, paths and outlined text generally use a flattened image. PPTX unsupported shapes, media or effects may be omitted with notes; review every imported page before use. PDF and native Canva document formats are not supported by this bridge.

## Optional Chromium extension

The source is in [`extensions/canva-bridge`](../extensions/canva-bridge). It is a Manifest V3 extension for Chrome, Brave and Microsoft Edge. It is loaded unpacked; it is not currently published in a browser extension store.

### Install locally

1. Download the **Chromium extension** ZIP from the editor's **Import from Canva** dialog, then extract it. Alternatively, download or clone this repository.
2. Open `chrome://extensions`, `brave://extensions` or `edge://extensions` in the browser where you use Canva.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select the extracted folder containing `manifest.json`. For a repository checkout, select `extensions/canva-bridge`.
5. Pin **Open Design Studio Import Bridge** if you want its button beside the address bar.

The extension source runs without a build step or npm dependencies. To generate the downloadable package from a repository checkout, run `npm install`, then `npm run package:extension`. This creates `public/canva-bridge.zip`, which the editor's import dialog makes available for download. Extract the ZIP before using **Load unpacked**; browsers do not load the archive directly.

The editor still needs to be running or hosted separately. For local development, run `npm run dev` in the repository root. The default editor address is `http://127.0.0.1:4480/`.

### Use the bridge

1. Open your Canva design and click the extension button.
2. Click **Open Canva download menu**. The helper follows visible **Share → Download** controls. You select the format and confirm the actual download in Canva.
3. Open the extension again and select the exported local file under **Prepare your export**.
4. Click **Download transfer file**. This creates `<name>.canva-import.json` on your device.
5. Click **Open in Open Design Studio** and select the transfer file in the editor's import dialog.

You can skip the transfer-file step and import the original downloaded file directly. The transfer file is a portable local envelope, not a new Canva export format. It contains the same downloaded bytes and does not extract extra layers or improve their editability.

If the menu helper does not match Canva's current interface or language, choose **Share → Download** yourself. The helper does not use private endpoints or automate the final download confirmation. Supported English, Malay, Chinese and Tamil labels are matched on a best-effort basis.

Expand **Editor address** to use your own hosted editor. Only HTTPS addresses and HTTP on `localhost`, `127.0.0.1` or `[::1]` are accepted. Query strings and fragments are removed, then `?import=canva` is added when opening the import dialog.

### Permissions and local data

- `activeTab` grants temporary access to the tab where you invoke the extension.
- `scripting` allows the explicit download-menu button to click the visible Share and Download controls on an active `canva.com/design/...` page.
- There are no broad host permissions, background scripts, content scripts, download-monitoring permissions, account connections or analytics.
- The bridge does not read Canva cookies, passwords, tokens, private design state or the hidden element tree.
- Your chosen editor URL is stored in the extension's local storage. Your selected export is read only when you prepare the local transfer file.
- The bridge does not upload files. Opening your configured editor starts that editor's normal application behavior; use an editor deployment you trust.

The bridge accepts source files up to **30 MB**. Base64 encoding increases the transfer file size by approximately one third. Larger originals can be imported directly, subject to the editor's file and document limits. Keep the popup open until transfer preparation finishes.

### Transfer file contract

```json
{
  "format": "open-design-studio-canva-transfer",
  "version": 1,
  "name": "My presentation.pptx",
  "mimeType": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "data": "BASE64_OF_THE_ORIGINAL_FILE_BYTES"
}
```

`data` is raw base64, without a data-URL prefix. The file name retains the original supported extension. The editor validates the envelope and passes the decoded file through the same file importer used by direct imports. This envelope does not contain browser-session information or Canva credentials.

## Future official connection

Canva's supported APIs need a registered integration and user permission. Its REST API uses OAuth with PKCE and requires configured credentials; its in-Canva Design Editing API can read supported pages and elements with the appropriate app permissions. These are separate integrations and are not implemented by this local file bridge.

- [Canva API authentication](https://www.canva.dev/docs/apps/rest-apis/authentication/)
- [Canva Design Editing API](https://www.canva.dev/docs/apps/design-editing/)
- [Canva openDesign permissions](https://www.canva.dev/docs/apps/api/latest/design-open-design/)
- [Canva export workflow and supported formats](https://www.canva.dev/docs/apps/exporting-designs/)

Canva currently states that public export-only apps are not accepted. A future official connection would need an eligible app workflow and review, plus a clear mapping for unsupported content.
