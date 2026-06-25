// CD+G (CD Graphics) renderer — draws synchronized karaoke lyrics to a canvas.
// Format: 75 packets/second, 24 bytes each. Screen: 300×216 pixels (50×18 tiles of 6×12).

const CDG_COMMAND      = 0x09;
const CDG_PACKET_SIZE  = 24;
const CDG_FPS          = 75;
const CDG_WIDTH        = 300;
const CDG_HEIGHT       = 216;
const CDG_TILE_W       = 6;
const CDG_TILE_H       = 12;
const TILES_H          = CDG_WIDTH  / CDG_TILE_W;  // 50
const TILES_V          = CDG_HEIGHT / CDG_TILE_H;  // 18

const CMD_MEMORY_PRESET  = 1;
const CMD_BORDER_PRESET  = 2;
const CMD_TILE_BLOCK     = 6;
const CMD_SCROLL_PRESET  = 20;
const CMD_SCROLL_COPY    = 24;
const CMD_SET_KEY_COLOR  = 28;
const CMD_LOAD_CLUT_LOW  = 30;
const CMD_LOAD_CLUT_HIGH = 31;
const CMD_TILE_BLOCK_XOR = 38;

class CDGRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.canvas.width  = CDG_WIDTH;
    this.canvas.height = CDG_HEIGHT;
    this.ctx = canvas.getContext('2d');

    this._initState();
    this.packets = null;
    this.currentPacket = 0;
  }

  _initState() {
    // 16-entry color table, each [r, g, b] as 0–255
    this.colorTable = Array.from({ length: 16 }, () => [0, 0, 0]);
    // Per-pixel color index (300×216)
    this.pixels = new Uint8Array(CDG_WIDTH * CDG_HEIGHT);
    this.keyColor = -1;
    this.imageData = this.ctx.createImageData(CDG_WIDTH, CDG_HEIGHT);
  }

  load(arrayBuffer) {
    this.packets = new Uint8Array(arrayBuffer);
    this.fps = CDG_FPS; // reset to default; calibrate() will refine it
    this.reset();
  }

  // Call after audio duration is known to derive the real packet rate from file size.
  // This fixes sync for files authored at rates other than 75 Hz.
  calibrate(audioDuration) {
    if (!this.packets || !audioDuration || !isFinite(audioDuration) || audioDuration <= 0) return;
    const totalPackets = Math.floor(this.packets.length / CDG_PACKET_SIZE);
    const computed = totalPackets / audioDuration;
    // Sanity-check: accept rates between 20 and 600 Hz
    if (computed >= 20 && computed <= 600) {
      this.fps = computed;
      console.log(`CDG calibrated: ${computed.toFixed(2)} Hz (${totalPackets} packets / ${audioDuration.toFixed(2)}s)`);
    }
  }

  reset() {
    this._initState();
    this.currentPacket = 0;
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, CDG_WIDTH, CDG_HEIGHT);
  }

  // Advance renderer to match audioCurrentTime (seconds).
  seekTo(timeSeconds) {
    if (!this.fps) this.fps = CDG_FPS;
    const target = Math.floor(timeSeconds * this.fps);
    if (target < this.currentPacket) {
      this._initState();
      this.currentPacket = 0;
    }
    this._renderUpTo(target);
  }

  _renderUpTo(target) {
    if (!this.packets) return;
    const total = Math.floor(this.packets.length / CDG_PACKET_SIZE);
    const limit = Math.min(target, total);
    while (this.currentPacket < limit) {
      this._processPacket(this.currentPacket * CDG_PACKET_SIZE);
      this.currentPacket++;
    }
    this._paint();
  }

  _processPacket(offset) {
    const p = this.packets;
    if ((p[offset] & 0x3F) !== CDG_COMMAND) return;
    const instr = p[offset + 1] & 0x3F;
    // Data bytes start at offset+4, 16 bytes
    const d = offset + 4;

    switch (instr) {
      case CMD_MEMORY_PRESET:  this._memPreset(p, d);         break;
      case CMD_BORDER_PRESET:  this._borderPreset(p, d);      break;
      case CMD_TILE_BLOCK:     this._tileBlock(p, d, false);  break;
      case CMD_TILE_BLOCK_XOR: this._tileBlock(p, d, true);   break;
      case CMD_SCROLL_PRESET:  this._scroll(p, d, false);     break;
      case CMD_SCROLL_COPY:    this._scroll(p, d, true);      break;
      case CMD_SET_KEY_COLOR:  this.keyColor = p[d] & 0x0F;   break;
      case CMD_LOAD_CLUT_LOW:  this._loadClut(p, d, 0);       break;
      case CMD_LOAD_CLUT_HIGH: this._loadClut(p, d, 8);       break;
    }
  }

  _memPreset(p, d) {
    const color  = p[d]     & 0x0F;
    const repeat = p[d + 1] & 0x0F;
    if (repeat === 0) this.pixels.fill(color);
  }

  _borderPreset(p, d) {
    const color = p[d] & 0x0F;
    for (let y = 0; y < CDG_HEIGHT; y++)
      for (let x = 0; x < CDG_WIDTH; x++)
        if (x < 6 || x >= CDG_WIDTH - 6 || y < 12 || y >= CDG_HEIGHT - 12)
          this.pixels[y * CDG_WIDTH + x] = color;
  }

  _tileBlock(p, d, xor) {
    const color0 = p[d]     & 0x0F;
    const color1 = p[d + 1] & 0x0F;
    const row    = p[d + 2] & 0x1F;
    const col    = p[d + 3] & 0x3F;
    if (row >= TILES_V || col >= TILES_H) return;

    const xBase = col * CDG_TILE_W;
    const yBase = row * CDG_TILE_H;

    for (let r = 0; r < CDG_TILE_H; r++) {
      const rowBits = p[d + 4 + r] & 0x3F;
      for (let c = 0; c < CDG_TILE_W; c++) {
        const bit = (rowBits >> (5 - c)) & 1;
        const idx = (yBase + r) * CDG_WIDTH + (xBase + c);
        this.pixels[idx] = xor
          ? this.pixels[idx] ^ (bit ? color1 : color0)
          : (bit ? color1 : color0);
      }
    }
  }

  _scroll(p, d, copy) {
    const color   = p[d]     & 0x0F;
    const hScroll = p[d + 1] & 0x3F;
    const vScroll = p[d + 2] & 0x3F;

    const hCmd = (hScroll >> 4) & 0x03;
    const vCmd = (vScroll >> 4) & 0x03;

    const hDelta = hCmd === 1 ? CDG_TILE_W : hCmd === 2 ? -CDG_TILE_W : 0;
    const vDelta = vCmd === 1 ? CDG_TILE_H : vCmd === 2 ? -CDG_TILE_H : 0;
    if (hDelta === 0 && vDelta === 0) return;

    const next = new Uint8Array(CDG_WIDTH * CDG_HEIGHT);
    for (let y = 0; y < CDG_HEIGHT; y++) {
      for (let x = 0; x < CDG_WIDTH; x++) {
        const sx = x - hDelta;
        const sy = y - vDelta;
        if (sx < 0 || sx >= CDG_WIDTH || sy < 0 || sy >= CDG_HEIGHT) {
          next[y * CDG_WIDTH + x] = copy
            ? this.pixels[((sy + CDG_HEIGHT) % CDG_HEIGHT) * CDG_WIDTH + ((sx + CDG_WIDTH) % CDG_WIDTH)]
            : color;
        } else {
          next[y * CDG_WIDTH + x] = this.pixels[sy * CDG_WIDTH + sx];
        }
      }
    }
    this.pixels = next;
  }

  _loadClut(p, d, base) {
    for (let i = 0; i < 8; i++) {
      const b0 = p[d + i * 2]     & 0x3F;
      const b1 = p[d + i * 2 + 1] & 0x3F;
      // 12-bit color packed as: byte0 = 00RRRRGG, byte1 = 00GGBBBB
      const r4 = (b0 >> 2) & 0x0F;
      const g4 = ((b0 & 0x03) << 2) | ((b1 >> 4) & 0x03);
      const b4 = b1 & 0x0F;
      // Scale 4-bit to 8-bit
      this.colorTable[base + i] = [r4 * 17, g4 * 17, b4 * 17];
    }
  }

  _paint() {
    const data = this.imageData.data;
    for (let i = 0; i < CDG_WIDTH * CDG_HEIGHT; i++) {
      const [r, g, b] = this.colorTable[this.pixels[i]];
      data[i * 4]     = r;
      data[i * 4 + 1] = g;
      data[i * 4 + 2] = b;
      data[i * 4 + 3] = 255;
    }
    this.ctx.putImageData(this.imageData, 0, 0);
  }
}
