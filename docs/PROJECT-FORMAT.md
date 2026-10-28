# Project format, version 1

Open Design Studio uses a JSON project envelope containing a versioned editable document. The downloadable extension is `.design.json`.

A native project preserves all pages, editable elements and embedded image sources. PNG, JPEG and SVG exports are visual outputs, not substitutes for a native project backup.

## Envelope

```json
{
  "id": "project-example",
  "title": "My first design",
  "createdAt": "2026-10-29T00:00:00.000Z",
  "updatedAt": "2026-10-29T00:00:00.000Z",
  "document": {
    "format": "open-design-studio",
    "version": 1,
    "width": 1080,
    "height": 1350,
    "pages": [
      {
        "id": "page-example",
        "name": "Page 1",
        "background": "#ffffff",
        "elements": []
      }
    ]
  }
}
```

| Field | Meaning |
| --- | --- |
| `id` | Project identity used by the local library; 1–64 ASCII letters, digits, `_` or `-`. |
| `title` | Nonblank project title, at most 160 characters. |
| `createdAt`, `updatedAt` | UTC ISO timestamps with milliseconds, such as `2026-10-29T00:00:00.000Z`. The update time cannot precede creation. |
| `document.format` | Must be `open-design-studio`. |
| `document.version` | Must be the supported version, currently `1`. |
| `document.width`, `document.height` | Shared page dimensions in design pixels, independent of workspace zoom. |
| `document.pages` | Ordered pages. Export order follows this array. |

Each page has an `id`, nonblank `name` (at most 160 characters), hexadecimal `background` and ordered `elements` array. Elements are stacked from back to front in array order. Page and element IDs must be unique across the document and use the same identifier syntax as a project ID. IDs must remain stable while editing their records.

## Elements

Version 1 supports `text`, `image`, `rect` and `ellipse` elements. All elements require `id`, `name`, `type`, `x`, `y`, `width`, `height`, `rotation`, `opacity`, `locked` and `visible`. Element names may be blank but must not exceed 160 characters. Position uses design coordinates and a top-left origin; rotation is measured in degrees.

### Logical groups

An element may additionally contain `groupId`, using the same identifier syntax as element IDs. Elements with the same `groupId` belong to one logical group on one page. A group ID must not equal any page or element ID, and it cannot be reused on another page. Groups cannot nest: there is no group object or parent transform in this format.

Each member still stores its own complete world position, size and rotation. Grouping or ungrouping therefore does not change exported appearance. The editor keeps a group's members together in stack order and uses a temporary Fabric active selection for joint movement, rotation and uniform resizing. That temporary selection is never serialized. Single-member groups are accepted by the parser so removing a member cannot make a project unreadable; editors may dissolve those memberships during normal editing.

Documents without `groupId` remain valid version 1 documents. Older strict readers that predate this optional field may reject grouped files; update the reader to support group metadata before exchanging those files.

For example, this is a complete editable text element:

```json
{
  "id": "headline-example",
  "name": "Headline",
  "type": "text",
  "x": 80,
  "y": 240,
  "width": 920,
  "height": 160,
  "rotation": 0,
  "opacity": 1,
  "locked": false,
  "visible": true,
  "text": "Make something new",
  "fill": "#20242c",
  "fontSize": 72,
  "fontFamily": "Arial",
  "fontWeight": 700,
  "textAlign": "left",
  "letterSpacing": 0
}
```

- **Text** requires `text`, `fontFamily`, `fontSize`, `fontWeight` (`400` or `700`) and `textAlign` (`left`, `center` or `right`). `fill` and `letterSpacing` are optional.
- **Images** store a PNG, JPEG or WebP data URL in `src` and retain independent layout dimensions. The original image bytes travel with the project.
- **Rectangles and ellipses** use the common geometry and optional `fill`. A rectangle may also have `borderRadius` from 0 to 2048.

Colours use `#RRGGBB` or `#RRGGBBAA`. An element fill may additionally be `transparent`. Unknown fields, non-finite numeric values and unsupported types are rejected rather than passed through to Fabric.

The TypeScript model and runtime parser in [`src/core/model.ts`](../src/core/model.ts) are the authoritative definitions for required fields and validation. Build files through those helpers rather than using raw Fabric serialization. Fabric instance state, event handlers and selection controls are not part of the portable format.

## Limits

Limits apply when importing and validating a project, not only when entering values in the UI.

| Item | Version 1 limit |
| --- | --- |
| Page width and height | Integer, 320–4096 design pixels each |
| Pages | 1–12 |
| Elements | 150 per page; 1000 across the document |
| Position `x`, `y` | −16384 to 16384 |
| Element width and height | 0.1–16384 |
| Rotation | −360 to 360 degrees |
| Opacity | 0–1 |
| Text length | 5000 characters per element; 50000 total |
| Text size | 6–512 design pixels |
| Optional letter spacing | −10 to 100 |
| Embedded image file | At most 10 MiB |
| Decoded image | At most 8192 pixels per side and 32 megapixels |
| Page image rendering | At most 64 megapixels across unique decoded sources |
| Total embedded images | 30 MiB, counting each identical source once |
| Document JSON | 45 MiB |
| Imported project file | 50 MiB |

The milestone font families are Arial, Georgia, Times New Roman, Courier New, Verdana and Trebuchet MS. Available glyphs and actual rendering depend on fonts installed on the device.

## Images

Image sources must use supported base64 data URLs:

```text
data:image/png;base64,...
data:image/jpeg;base64,...
data:image/webp;base64,...
```

The importer checks the declared media type, image signature and decoded dimensions. Animated WebP is not supported. Remote URLs, HTML and SVG image sources are outside this version's supported format. Base64 encoding increases JSON file size compared with the original image bytes.

Uploaded artwork is one image element. Flattened text and shapes inside it are not automatically recovered as separate editable objects.

## Save and export behavior

The local library stores complete project envelopes, including embedded images, in IndexedDB. Browser storage and file download are separate operations: a local autosave does not create an independent backup.

Raster exports support 1× or 2× dimensions within a 32-megapixel ceiling. JPEG flattens transparency onto white. SVG exports are resolution independent; fonts are not embedded or outlined, so another application may substitute missing fonts and alter line wrapping or spacing.

All-pages export renders pages in sequence into a ZIP. Output names use ordered page numbers and a sanitized name, such as `page-01-cover.png`, with a `README.txt` explaining the output. The ZIP does not include the editable project automatically; download that separately.

ZIP export is bounded by 120 MiB of combined output files and an estimated 128 MiB raw raster budget. These limits may prevent very large batches even when each page would export separately. Lower the raster scale, reduce the canvas dimensions or export pages individually if necessary.

## Compatibility

An importer must check `format` and `version` before rendering. Unsupported versions should produce a readable error. Future changes to field meanings require an explicit version/migration policy.

Viewport pan, zoom, focused controls, selection, open panels and the undo history are temporary editor state. They are not required to reconstruct a design from a downloaded project.

Persistent `groupId` membership is document data. Skew, reflection and nested group transforms are not supported. Joint transforms must be captured back into each member's world geometry before saving; workspace CSS zoom is never part of those values.

This format does not embed fonts, executable code, credentials, cloud connections, native Illustrator data or live collaboration state.
