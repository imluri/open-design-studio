# Contributing

Thanks for helping improve Open Design Studio. Small, focused changes are easier to review and keep editable projects compatible.

## Setup

Use Node.js 22.22 or newer.

```sh
npm install
npm run dev
```

Before sending a pull request:

```sh
npm run build
```

This checks TypeScript and builds the app. It is not an automated test suite. Describe the manual checks you performed and any behavior you could not check.

## Architecture

- `src/core/` owns the document model, validation, browser storage, portable project files, Fabric rendering and output generation.
- `src/ui/` owns React controls, selection, keyboard handling and canvas viewport interactions.
- The versioned document stores design content in design coordinates. Pan, zoom, selection and open panels are temporary UI state.
- Persist application data from the project model. A raw Fabric canvas dump is not the native project format.
- Keep browser storage errors visible and recoverable. A failed autosave must not be presented as a successful save.

Keep generic editing behavior separate from any future storage, account or AI integration. The first milestone must remain usable without a backend or API key.

## Project compatibility

Read [PROJECT-FORMAT.md](docs/PROJECT-FORMAT.md) before changing a model field, image policy or importer.

1. Validate imported data before it reaches rendering or storage.
2. Bound dimensions, element counts and decoded image sizes.
3. Reject unknown document versions with a useful error. Add an explicit migration when introducing a new supported version.
4. Treat project titles, page names and text as plain data. Do not render them as HTML or evaluate imported strings.
5. Preserve embedded image bytes and proportions when editing or downloading a project.
6. Keep native project downloads separate from flattened image exports.

## Interaction and accessibility

Use real buttons with accessible names for icon actions. Preserve keyboard focus, visible focus styles, and usable touch targets. Modal dialogs must contain focus and restore it when they close.

Canvas shortcuts must not interrupt normal typing in text fields, text editing, or open modal dialogs. Zoom and pan change the view, not the saved element positions. Check that undo and redo affect document edits rather than temporary viewport movement.

## Manual review

For an editor change, describe the relevant checks in the pull request. Useful cases include:

- Create, edit and reopen a project with more than one page.
- Resize and rotate text and images; confirm aspect ratio and text layout.
- Edit a text field using the keyboard without triggering canvas shortcuts.
- Pan, zoom and return to Fit; confirm element positions did not change.
- Undo and redo the affected action.
- Download a native project and reopen it in a fresh browser session.
- Export PNG, JPEG and SVG; inspect fonts, transparency and page order.
- Inspect a narrow viewport and keyboard-only navigation.
- Confirm malformed, unsupported or oversized imports show useful errors.

Use synthetic content. Do not include customer projects, internal records, credentials or private brand assets in examples, issues or pull requests.

## Assets and dependencies

Contribute assets only when their license permits redistribution. Record their source and license. A font available on your computer is not automatically licensed for bundling.

Explain any new dependency and its license. Keep the package lockfile and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) consistent with dependency changes. Do not add a commercial SDK or a mandatory external service to the local editor without discussing the scope first.

## Pull requests

Explain what changed, why, how you checked it, and any compatibility or data-loss risk. Include screenshots for UI changes. Keep unrelated formatting and refactors out of the same change.

Contributions you submit for inclusion are provided under the project's MIT license. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
