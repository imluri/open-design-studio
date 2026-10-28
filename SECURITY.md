# Security

## Reporting a vulnerability

Use the repository's **Security → Report a vulnerability** option when available to send a private report to the maintainer. If private reporting is unavailable, contact [imluri on GitHub](https://github.com/imluri) to arrange a private reporting channel before sharing exploit details.

Include the affected revision, browser and operating system, reproduction steps, expected and actual behavior, and a minimal synthetic project if it helps. Do not attach confidential designs or personal data. Please keep working exploit details out of public issues until the maintainer has reviewed the report.

The current milestone on the default branch is the supported development line. There is no guaranteed response time or security support for old snapshots.

## Data and trust model

- This milestone is a static, local-first browser editor. It has no account service or cloud project sync.
- Its project library and autosave use IndexedDB under the hosting site's origin and current browser profile.
- Local projects are not encrypted by the editor or isolated from other people using the same browser profile. Browser extensions and scripts running under the same origin may also have access.
- Downloading a native project embeds its image sources. Share the file only with recipients who should receive those images and text.
- Browser storage can be denied, cleared or evicted. Download project backups for retention.

The open source repository contains application code and generic examples. A user's local project library is not included when the repository is published.

## Imported files

Project files, image metadata and text are untrusted input. Keep format/version checks, type validation, count limits and decoded-image limits in place. The supported native format embeds PNG, JPEG or WebP data URLs; external image URLs and active HTML are outside this milestone's format.

The file format is intended for design data, not secrets or executable content. Native Illustrator files, SVG import and arbitrary scripting are not supported.

## Hosting

Deploy the built static files on an origin you control. Use HTTPS, keep dependencies current, and avoid adding untrusted scripts to the editor's origin. Any custom hosting analytics, remote asset services or future integrations need their own privacy and security review.

Do not put API secrets into frontend environment variables or a project file. The shipped JavaScript and downloaded projects are readable by their recipients.
