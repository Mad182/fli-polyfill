# fli-polyfill

A lightweight JavaScript polyfill that brings animated **FLIC** (.fli, .flc) support to modern browsers.

Made for [ezgif.com](https://ezgif.com).

## What is FLIC?

FLIC is a family of animation file formats originally created by Autodesk for Animator and Animator Pro in the early 1990s. The two main variants are FLI (original, fixed 320×200) and FLC (extended, arbitrary resolution). FLIC files use indexed color with 256-color palettes and various delta-compression schemes for efficient frame storage. While long obsolete for general use, FLIC files still appear in legacy content and retro computing contexts. This polyfill parses FLIC files in JavaScript and renders them to `<canvas>`. I use it on my [FLI to GIF converter](https://ezgif.com/fli-to-gif).

## Features

- **Drop-in polyfill**: automatically detects `<img>` tags with `.fli` or `.flc` sources and replaces them with animated `<canvas>` elements.
- **Full format support**: handles both FLI (0xAF11) and FLC (0xAF12) file types.
- **All compression types**: decodes BYTE_RUN, DELTA_FLI, DELTA_FLC, FLI_COPY, and BLACK frame chunks.
- **Palette handling**: supports both COLOR_64 (FLI) and COLOR_256 (FLC) palette chunks with proper scaling.
- **Accurate animation timing**: FLI files use 1/70s tick units, FLC files use millisecond delays — both handled correctly.
- **MutationObserver**: watches for dynamically added `.fli`/`.flc` images (e.g., lazy-loaded or SPA content) and polyfills them automatically.
- **Programmatic API**: `FLIPlayer` class for full playback control (play, pause, stop, dispose).
- **Zero dependencies**: single self-contained file, no build step required.
- **Graceful fallback**: if a FLIC file fails to load, the original `<img>` tag is restored.

## Usage

### Drop-in

Include the script on your page. Any `<img>` with a `.fli` or `.flc` source will be automatically replaced with an animated canvas:

```html
<script src="fli-polyfill.js"></script>
<img src="animation.fli" alt="Animated FLIC">
```

Including the script is all you need to get FLIC files working.

### Data attribute

Use `data-fli-src` if you prefer to keep a fallback `src`:

```html
<script src="fli-polyfill.js"></script>
<img src="fallback.png" data-fli-src="animation.fli" alt="Animated FLIC">
```

### Programmatic API

```js
const canvas = document.getElementById('my-canvas');
const player = new FLIPlayer(canvas, {
    autoplay: true  // start playing when loaded (default: true)
});

player.load('animation.fli').then(() => {
    console.log('Frames:', player.data.frameCount);
    console.log('Delay:', player.data.delayMs + 'ms');
});

// Playback controls
player.pause();
player.play();
player.stop();     // stop and reset to first frame

// Clean up when done
player.dispose();
```

### Global API

```js
// Re-scan the DOM for new .fli/.flc images
FLIPolyfill.scan();

// Parse raw FLIC data
const result = FLIPolyfill.parseFLIC(uint8Array);
console.log(result.width, result.height, result.frames.length);

// Player class reference
const player = new FLIPolyfill.Player(canvas);
```

## CDN / Installation

Copy `fli-polyfill.js` into your project and include it with a `<script>` tag. No package manager or build step needed.

```html
<script src="fli-polyfill.js"></script>
```

## CORS

The polyfill uses `fetch()` to download `.fli`/`.flc` files. If the file is served from a different domain than the page, the server must include the appropriate CORS header:

```
Access-Control-Allow-Origin: *
```

## License

[MIT](LICENSE)
