# Instagram Downloader

![icon](icons/icon128.png)

Instagram Downloader is a Manifest V3 browser extension for saving media from Instagram. The project initially started as a fork of an existing Instagram downloader, but it has since been substantially reworked and expanded. The current implementation includes a different download flow, automatic media detection across Instagram's main views, carousel support, and several export formats.

## Features

- Download photos and videos from posts, including carousel posts.
- Download the currently visible media directly from an overlay button.
- Download reels and TV videos.
- Download the latest stories and highlight stories.
- Detect media in the home feed, profile grids, Explore, post modals, dedicated post pages, reels, stories, and highlights.
- Request high-resolution media from Instagram where available.
- Download all carousel items individually.
- Download carousel items as a ZIP archive.
- Download carousel images as a PDF, with one image per page. Video items are skipped in the PDF export.
- Use a multi-select flow to choose specific media before downloading.
- Cache media information to reduce repeated requests for the same post.
- Support keyboard shortcuts for common actions.

## Browser compatibility

The extension is intended for Chromium-based browsers and Firefox. It has been tested with:

- Google Chrome
- Microsoft Edge
- Firefox

## Download and install

- Download the [latest release](https://github.com/HOAIAN2/Instagram-Downloader/releases) and extract it to a folder.

### Chrome or another Chromium browser

1. Enable Developer mode in the extensions page.
2. Open `chrome://extensions/` (or the equivalent page in your browser).
3. Click **Load unpacked** and select the extracted project folder.

### Firefox

1. Open `about:addons`.
2. Open the extensions menu and choose **Debug Add-ons**.
3. Click **Load Temporary Add-on...** and select `manifest.json`.

## Usage

Open Instagram and navigate to a post, reel, story, highlight, or carousel. Click the download button shown beside the relevant media or in Instagram's action bar.

For a carousel, use the multi-download button to download all items. A long press on that button opens the format menu with:

- **Download as ZIP** — saves every carousel item as a separate file in an archive.
- **Download as PDF** — creates a PDF with one page for each image in the carousel.

The extension also detects posts while scrolling the home feed, so opening the comments or post modal is not required. The overlay button downloads the media item that is currently visible.

## Keyboard shortcuts

Shortcuts work when focus is not inside an input, textarea, search field, or another text-entry element.

- Download: `D`
- Close: `Esc` or `C`
- Select all: `S`

## Development

Runtime code is in `src/js/`. The extension has no bundler or compilation step.

```bash
make format
make format-check
```

To test locally, load the repository folder as an unpacked extension and manually verify posts, carousels, reels, stories, highlights, overlays, ZIP/PDF exports, keyboard shortcuts, and browser console errors.

The `IG_` constants are compatibility-sensitive and should not be renamed casually.

## Customization

The extension's shared styles are in `src/style/style.css`. You can adjust the interface and transition effects there. Keep changes to `manifest.json`, host permissions, injected scripts, and download handling narrowly scoped because they run on Instagram pages and process user media.

## Notes

If the extension is stored on an external partition or drive, make sure that partition is mounted before starting the browser. Otherwise, the browser may remove the extension from its loaded extensions list.

## Demo

[Demo v5.1.0](https://github.com/HOAIAN2/Instagram-Downloader/assets/98139595/917369c9-cdbb-4315-8e6d-7a1632a8888b)
