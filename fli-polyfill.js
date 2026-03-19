/**
 * fli-polyfill.js — Browser polyfill for animated FLIC (.fli, .flc) files.
 * 
 * https://github.com/Mad182/fli-polyfill
 *
 * Implements full FLIC parsing and playback:
 *   - Parses FLIC header (128 bytes) for both FLI (0xAF11) and FLC (0xAF12)
 *   - Decodes all frame chunk types: BYTE_RUN, DELTA_FLI, DELTA_FLC, FLI_COPY, BLACK
 *   - Handles palette chunks: COLOR_64 (FLI) and COLOR_256 (FLC)
 *   - Proper frame delay handling (1/70s for FLI, milliseconds for FLC)
 *   - Renders frames to a <canvas> element with indexed-color to RGBA conversion
 *   - Automatically replaces <img> tags with .fli/.flc src attributes
 *
 * Usage:
 *   <script src="fli-polyfill.js"></script>
 *   <img src="animation.fli" alt="Animated FLIC">
 *
 * Or programmatically:
 *   const player = new FLIPlayer(canvasElement);
 *   player.load('animation.fli').then(() => player.play());
 *
 * License: MIT
 */

(function (global) {
    'use strict';

    // ========================================================================
    // Binary read helpers (little-endian, as per FLIC spec)
    // ========================================================================

    function readU16(data, offset) {
        return data[offset] | (data[offset + 1] << 8);
    }

    function readU32(data, offset) {
        return (data[offset] | (data[offset + 1] << 8) |
                (data[offset + 2] << 16) | (data[offset + 3] << 24)) >>> 0;
    }

    function readI16(data, offset) {
        var val = data[offset] | (data[offset + 1] << 8);
        return (val > 0x7FFF) ? val - 0x10000 : val;
    }

    // ========================================================================
    // FLIC Constants
    // ========================================================================

    var FLI_TYPE = 0xAF11;
    var FLC_TYPE = 0xAF12;

    // Frame chunk type
    var FRAME_MAGIC = 0xF1FA;

    // Prefix chunk type (FLC only, skip)
    var PREFIX_MAGIC = 0xF100;

    // Sub-chunk types
    var COLOR_256    = 0x04;
    var DELTA_FLC    = 0x07;
    var COLOR_64     = 0x0B;
    var DELTA_FLI    = 0x0C;
    var BLACK        = 0x0D;
    var BYTE_RUN     = 0x0F;
    var FLI_COPY     = 0x10;
    var PSTAMP       = 0x12;

    // ========================================================================
    // FLIC Parser
    // ========================================================================

    /**
     * @typedef {Object} FLICParseResult
     * @property {number} width
     * @property {number} height
     * @property {number} frameCount
     * @property {number} delayMs         - Per-frame delay in milliseconds
     * @property {boolean} isFLC          - true if FLC, false if FLI
     * @property {Uint8Array[]} frames    - Array of RGBA pixel arrays per frame
     */

    function parseFLIC(data) {
        if (!(data instanceof Uint8Array)) {
            data = new Uint8Array(data);
        }

        if (data.length < 128) {
            throw new Error('File too small to be a FLIC file');
        }

        // Read 128-byte header
        var fileSize     = readU32(data, 0);
        var fileType     = readU16(data, 4);
        var numFrames    = readU16(data, 6);
        var width        = readU16(data, 8);
        var height       = readU16(data, 10);
        var depth        = readU16(data, 12);
        var frameDelay   = readU32(data, 16);

        if (fileType !== FLI_TYPE && fileType !== FLC_TYPE) {
            throw new Error('Not a valid FLIC file (type: 0x' + fileType.toString(16) + ')');
        }

        var isFLC = (fileType === FLC_TYPE);

        // Frame delay: FLI = 1/70s units, FLC = milliseconds
        var delayMs;
        if (isFLC) {
            delayMs = frameDelay;
        } else {
            delayMs = Math.round(frameDelay * (1000 / 70));
        }

        // Minimum delay
        if (delayMs < 1) delayMs = 70; // ~14fps default

        // Pixel buffer (indexed, 8-bit)
        var pixels = new Uint8Array(width * height);

        // Palette: 256 entries * 3 (RGB)
        var palette = new Uint8Array(768);

        // Initialize palette to default VGA-ish (black)
        for (var i = 0; i < 768; i++) palette[i] = 0;

        // Decoded frames as RGBA ImageData arrays
        var frames = [];

        // Parse chunks starting at offset 128
        var pos = 128;

        while (pos < data.length && frames.length < numFrames + 1) {
            if (pos + 6 > data.length) break;

            var chunkSize = readU32(data, pos);
            var chunkType = readU16(data, pos + 4);

            if (chunkSize < 6) break; // invalid

            if (chunkType === PREFIX_MAGIC) {
                // Skip prefix chunk (FLC only, Animator Pro specific)
                pos += chunkSize;
                continue;
            }

            if (chunkType === FRAME_MAGIC) {
                // Frame chunk: 16-byte header
                var subChunkCount = readU16(data, pos + 6);

                var frameEnd = pos + chunkSize;
                var subPos = pos + 16; // skip 16-byte frame header

                for (var sc = 0; sc < subChunkCount && subPos + 6 <= frameEnd; sc++) {
                    var subSize = readU32(data, subPos);
                    var subType = readU16(data, subPos + 4);

                    if (subSize < 6) { subPos = frameEnd; break; }

                    var subData = subPos + 6;

                    switch (subType) {
                        case COLOR_256:
                            decodePalette256(data, subData, subPos + subSize, palette);
                            break;
                        case COLOR_64:
                            decodePalette64(data, subData, subPos + subSize, palette);
                            break;
                        case BYTE_RUN:
                            decodeByteRun(data, subData, subPos + subSize, pixels, width, height);
                            break;
                        case DELTA_FLI:
                            decodeDeltaFLI(data, subData, subPos + subSize, pixels, width);
                            break;
                        case DELTA_FLC:
                            decodeDeltaFLC(data, subData, subPos + subSize, pixels, width, height);
                            break;
                        case FLI_COPY:
                            decodeCopy(data, subData, subPos + subSize, pixels, width, height);
                            break;
                        case BLACK:
                            for (var bi = 0; bi < pixels.length; bi++) pixels[bi] = 0;
                            break;
                        case PSTAMP:
                            // Skip postage stamp
                            break;
                    }

                    subPos += subSize;
                }

                // Convert indexed pixels + palette to RGBA
                var rgba = new Uint8Array(width * height * 4);
                for (var p = 0; p < width * height; p++) {
                    var idx = pixels[p];
                    rgba[p * 4]     = palette[idx * 3];
                    rgba[p * 4 + 1] = palette[idx * 3 + 1];
                    rgba[p * 4 + 2] = palette[idx * 3 + 2];
                    rgba[p * 4 + 3] = 255;
                }
                frames.push(rgba);

                pos = frameEnd;
            } else {
                // Unknown top-level chunk, skip
                pos += chunkSize;
            }
        }

        // The last frame may be a "ring frame" for looping transition.
        // If we got numFrames+1, the last is the ring frame — remove it.
        if (frames.length > numFrames && numFrames > 0) {
            frames.length = numFrames;
        }

        return {
            width: width,
            height: height,
            frameCount: numFrames,
            delayMs: delayMs,
            isFLC: isFLC,
            frames: frames
        };
    }

    // ========================================================================
    // Palette decoders
    // ========================================================================

    function decodePalette256(data, pos, end, palette) {
        if (pos + 2 > end) return;
        var numPackets = readU16(data, pos);
        pos += 2;

        var colorIdx = 0;

        for (var pk = 0; pk < numPackets && pos < end; pk++) {
            var skip = data[pos++];
            var count = data[pos++];
            if (count === 0) count = 256;

            colorIdx += skip;

            for (var c = 0; c < count && pos + 2 < end; c++) {
                var ci = (colorIdx + c) & 0xFF;
                palette[ci * 3]     = data[pos++];
                palette[ci * 3 + 1] = data[pos++];
                palette[ci * 3 + 2] = data[pos++];
            }

            colorIdx += count;
        }
    }

    function decodePalette64(data, pos, end, palette) {
        if (pos + 2 > end) return;
        var numPackets = readU16(data, pos);
        pos += 2;

        var colorIdx = 0;

        for (var pk = 0; pk < numPackets && pos < end; pk++) {
            var skip = data[pos++];
            var count = data[pos++];
            if (count === 0) count = 256;

            colorIdx += skip;

            for (var c = 0; c < count && pos + 2 < end; c++) {
                var ci = (colorIdx + c) & 0xFF;
                // COLOR_64 values are in range 0-63, scale to 0-255
                palette[ci * 3]     = Math.min(data[pos++] << 2, 255);
                palette[ci * 3 + 1] = Math.min(data[pos++] << 2, 255);
                palette[ci * 3 + 2] = Math.min(data[pos++] << 2, 255);
            }

            colorIdx += count;
        }
    }

    // ========================================================================
    // Frame data decoders
    // ========================================================================

    /**
     * BYTE_RUN: RLE-compressed full frame.
     * Each line starts with a (ignored) packet count byte, then packets:
     *   positive type = repeat next byte 'type' times
     *   negative type = read |type| literal bytes
     */
    function decodeByteRun(data, pos, end, pixels, width, height) {
        for (var y = 0; y < height; y++) {
            if (pos >= end) break;

            // First byte is packet count — ignored per spec
            pos++;

            var x = 0;
            while (x < width && pos < end) {
                var type = (data[pos] > 127) ? data[pos] - 256 : data[pos];
                pos++;

                if (type > 0) {
                    // Repeat next byte 'type' times
                    if (pos >= end) break;
                    var val = data[pos++];
                    for (var r = 0; r < type && x < width; r++) {
                        pixels[y * width + x] = val;
                        x++;
                    }
                } else if (type < 0) {
                    // Read |type| literal bytes
                    var count = -type;
                    for (var l = 0; l < count && x < width && pos < end; l++) {
                        pixels[y * width + x] = data[pos++];
                        x++;
                    }
                }
                // type === 0: shouldn't happen but skip
            }
        }
    }

    /**
     * DELTA_FLI: Byte-oriented delta compression (FLI files).
     */
    function decodeDeltaFLI(data, pos, end, pixels, width) {
        if (pos + 4 > end) return;

        var linesToSkip = readU16(data, pos); pos += 2;
        var numLines    = readU16(data, pos); pos += 2;

        var y = linesToSkip;

        for (var line = 0; line < numLines && pos < end; line++) {
            var numPackets = data[pos++];

            var x = 0;
            for (var pk = 0; pk < numPackets && pos < end; pk++) {
                var skipCount = data[pos++];
                var packetType = (data[pos] > 127) ? data[pos] - 256 : data[pos];
                pos++;

                x += skipCount;

                if (packetType > 0) {
                    // Read 'packetType' literal pixels
                    for (var l = 0; l < packetType && x < width && pos < end; l++) {
                        pixels[y * width + x] = data[pos++];
                        x++;
                    }
                } else if (packetType < 0) {
                    // Repeat next byte |packetType| times
                    var count = -packetType;
                    if (pos >= end) break;
                    var val = data[pos++];
                    for (var r = 0; r < count && x < width; r++) {
                        pixels[y * width + x] = val;
                        x++;
                    }
                }
            }

            y++;
        }
    }

    /**
     * DELTA_FLC: Word-oriented delta compression (FLC files).
     */
    function decodeDeltaFLC(data, pos, end, pixels, width, height) {
        if (pos + 2 > end) return;

        var numLines = readU16(data, pos); pos += 2;
        var y = 0;
        var linesDecoded = 0;

        while (linesDecoded < numLines && pos + 2 <= end && y < height) {
            var word = readU16(data, pos); pos += 2;

            // Check top two bits
            var topBits = (word >> 14) & 3;

            if (topBits === 3) {
                // Skip lines: low 14 bits is skip count (stored as negative in unsigned form)
                var skipCount = 0x10000 - word; // two's complement
                y += skipCount;
                continue; // don't count this as a decoded line
            }

            if (topBits === 2) {
                // Last byte: store low byte at last pixel of current line
                if (y < height) {
                    pixels[y * width + (width - 1)] = word & 0xFF;
                }
                // Next word is the packet count
                if (pos + 2 > end) break;
                word = readU16(data, pos); pos += 2;
            }

            // word is now packet count
            var packetCount = word;
            var x = 0;

            for (var pk = 0; pk < packetCount && pos + 2 <= end; pk++) {
                var skipBytes = data[pos++];
                var sizeType = (data[pos] > 127) ? data[pos] - 256 : data[pos];
                pos++;

                x += skipBytes;

                if (sizeType > 0) {
                    // Read sizeType words (2 bytes each) literally
                    for (var w = 0; w < sizeType && pos + 1 < end; w++) {
                        if (x < width) pixels[y * width + x] = data[pos];
                        x++;
                        if (x < width) pixels[y * width + x] = data[pos + 1];
                        x++;
                        pos += 2;
                    }
                } else if (sizeType < 0) {
                    // Repeat next word |sizeType| times
                    var count = -sizeType;
                    if (pos + 1 >= end) break;
                    var b1 = data[pos++];
                    var b2 = data[pos++];
                    for (var r = 0; r < count; r++) {
                        if (x < width) pixels[y * width + x] = b1;
                        x++;
                        if (x < width) pixels[y * width + x] = b2;
                        x++;
                    }
                }
            }

            y++;
            linesDecoded++;
        }
    }

    /**
     * FLI_COPY: Uncompressed full frame data.
     */
    function decodeCopy(data, pos, end, pixels, width, height) {
        var total = width * height;
        var available = Math.min(total, end - pos);
        for (var i = 0; i < available; i++) {
            pixels[i] = data[pos + i];
        }
    }

    // ========================================================================
    // FLIPlayer — Canvas-based animation renderer
    // ========================================================================

    function FLIPlayer(canvas, options) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.options = options || {};

        /** @type {FLICParseResult|null} */
        this.data = null;

        /** Animation state */
        this._playing = false;
        this._frameIndex = 0;
        this._timerId = null;
        this._disposed = false;
    }

    /**
     * Load and parse a FLI/FLC file from a URL or ArrayBuffer.
     * @param {string|ArrayBuffer|Uint8Array} source
     * @returns {Promise<void>}
     */
    FLIPlayer.prototype.load = function (source) {
        var self = this;
        self.stop();

        var p;
        if (typeof source === 'string') {
            p = fetch(source).then(function (response) {
                if (!response.ok) throw new Error('Failed to fetch FLIC: ' + response.status);
                return response.arrayBuffer();
            });
        } else if (source instanceof ArrayBuffer) {
            p = Promise.resolve(source);
        } else if (source instanceof Uint8Array) {
            p = Promise.resolve(source.buffer.slice(
                source.byteOffset, source.byteOffset + source.byteLength
            ));
        } else {
            p = Promise.reject(new Error('Unsupported source type'));
        }

        return p.then(function (arrayBuffer) {
            self.data = parseFLIC(new Uint8Array(arrayBuffer));

            self.canvas.width = self.data.width;
            self.canvas.height = self.data.height;

            // Draw first frame
            self._frameIndex = 0;
            self._renderFrame(0);

            // Autoplay
            if (self.options.autoplay !== false && self.data.frames.length > 1) {
                self.play();
            }
        });
    };

    /** Start or resume animation playback */
    FLIPlayer.prototype.play = function () {
        if (this._playing || !this.data || this.data.frames.length <= 1) return;
        this._playing = true;
        this._scheduleNextFrame();
    };

    /** Pause animation */
    FLIPlayer.prototype.pause = function () {
        this._playing = false;
        if (this._timerId !== null) {
            clearTimeout(this._timerId);
            this._timerId = null;
        }
    };

    /** Stop and reset to first frame */
    FLIPlayer.prototype.stop = function () {
        this.pause();
        this._frameIndex = 0;
        if (this.data && this.data.frames.length > 0) {
            this._renderFrame(0);
        }
    };

    /** Clean up resources */
    FLIPlayer.prototype.dispose = function () {
        this.stop();
        this.data = null;
        this._disposed = true;
    };

    // -- Private methods --

    FLIPlayer.prototype._scheduleNextFrame = function () {
        if (!this._playing || !this.data) return;

        var self = this;
        var delay = Math.max(self.data.delayMs, 1);

        self._timerId = setTimeout(function () {
            self._timerId = null;
            if (!self._playing) return;

            var nextFrame = self._frameIndex + 1;

            if (nextFrame >= self.data.frames.length) {
                // Loop back to start
                nextFrame = 0;
            }

            self._frameIndex = nextFrame;
            self._renderFrame(nextFrame);
            self._scheduleNextFrame();
        }, delay);
    };

    FLIPlayer.prototype._renderFrame = function (index) {
        if (!this.data || this._disposed) return;
        if (index >= this.data.frames.length) return;

        var rgba = this.data.frames[index];
        var imageData = this.ctx.createImageData(this.data.width, this.data.height);
        imageData.data.set(rgba);
        this.ctx.putImageData(imageData, 0, 0);
    };

    // ========================================================================
    // Polyfill: Auto-detect and replace <img> tags with .fli/.flc sources
    // ========================================================================

    function isFliUrl(url) {
        if (!url) return false;
        var path = url.split('?')[0].split('#')[0].toLowerCase();
        return path.endsWith('.fli') || path.endsWith('.flc');
    }

    function polyfillImg(img) {
        if (img._fliPolyfilled) return;
        img._fliPolyfilled = true;

        var src = img.src || img.getAttribute('data-fli-src');
        if (!src) return;

        // Create a canvas replacement
        var canvas = document.createElement('canvas');

        // Copy relevant attributes
        canvas.className = img.className;
        canvas.id = img.id;
        canvas.title = img.title || img.alt || '';
        canvas.setAttribute('role', 'img');
        canvas.setAttribute('aria-label', img.alt || 'Animated FLIC image');

        // Copy inline styles
        if (img.style.cssText) {
            canvas.style.cssText = img.style.cssText;
        }

        // Copy data attributes
        for (var i = 0; i < img.attributes.length; i++) {
            var attr = img.attributes[i];
            if (attr.name.startsWith('data-') && attr.name !== 'data-fli-src') {
                canvas.setAttribute(attr.name, attr.value);
            }
        }

        // Transfer width/height if set as attributes
        if (img.hasAttribute('width')) {
            canvas.style.width = img.getAttribute('width') + 'px';
        }
        if (img.hasAttribute('height')) {
            canvas.style.height = img.getAttribute('height') + 'px';
        }

        var player = new FLIPlayer(canvas, {
            autoplay: true
        });

        // Replace the img with canvas
        if (img.parentNode) {
            img.parentNode.replaceChild(canvas, img);
        }

        // Store player reference
        canvas._fliPlayer = player;

        // Load the FLIC file
        player.load(src).catch(function (err) {
            console.warn('FLI polyfill: failed to load ' + src, err);
            // Restore original img on failure, but keep _fliPolyfilled = true
            // so the MutationObserver won't re-trigger an infinite retry loop
            if (canvas.parentNode) {
                img._fliFailed = true;
                canvas.parentNode.replaceChild(img, canvas);
            }
        });
    }

    function scanForFliImages() {
        var images = document.querySelectorAll(
            'img[src$=".fli"], img[src$=".FLI"], img[src$=".flc"], img[src$=".FLC"], img[data-fli-src]'
        );
        for (var i = 0; i < images.length; i++) {
            var img = images[i];
            if (isFliUrl(img.src) || img.hasAttribute('data-fli-src')) {
                polyfillImg(img);
            }
        }
    }

    /**
     * Watch for dynamically added FLI/FLC images.
     */
    function observeNewImages() {
        if (typeof MutationObserver === 'undefined') return;

        var observer = new MutationObserver(function (mutations) {
            for (var m = 0; m < mutations.length; m++) {
                var addedNodes = mutations[m].addedNodes;
                for (var n = 0; n < addedNodes.length; n++) {
                    var node = addedNodes[n];
                    if (node.nodeType !== 1) continue;
                    if (node.tagName === 'IMG' && (isFliUrl(node.src) || node.hasAttribute('data-fli-src'))) {
                        polyfillImg(node);
                    }
                    if (node.querySelectorAll) {
                        var imgs = node.querySelectorAll(
                            'img[src$=".fli"], img[src$=".FLI"], img[src$=".flc"], img[src$=".FLC"], img[data-fli-src]'
                        );
                        for (var i = 0; i < imgs.length; i++) {
                            polyfillImg(imgs[i]);
                        }
                    }
                }
            }
        });

        observer.observe(document.body || document.documentElement, {
            childList: true,
            subtree: true
        });
    }

    // ========================================================================
    // Initialization
    // ========================================================================

    function init() {
        scanForFliImages();
        observeNewImages();
    }

    // Run when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        setTimeout(init, 0);
    }

    // ========================================================================
    // Public API
    // ========================================================================

    global.FLIPlayer = FLIPlayer;
    global.FLIPolyfill = {
        parseFLIC: parseFLIC,
        scan: scanForFliImages,
        Player: FLIPlayer
    };

})(typeof window !== 'undefined' ? window : this);
