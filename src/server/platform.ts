// Server-side canvas platform (Skia via @napi-rs/canvas) with the studio fonts registered.
import { createCanvas, GlobalFonts, type Canvas as NapiCanvas } from '@napi-rs/canvas';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FONTS, fontFile } from '../engine/fonts.ts';
import type { Canvas, Platform } from '../engine/surface.ts';

const fontDir = fileURLToPath(new URL('../../public/fonts/', import.meta.url));
let fontsLoaded = false;

export function loadFonts() {
  if (fontsLoaded) return;
  fontsLoaded = true;
  let missing = 0;
  for (const f of FONTS) for (const w of f.weights) for (const s of f.italic ? ['normal', 'italic'] : ['normal']) {
    const file = fontDir + fontFile(f.id, w, s);
    if (existsSync(file)) GlobalFonts.registerFromPath(file, f.family);
    else missing++;
  }
  if (missing) console.warn(`[fonts] ${missing} font files missing — run "npm run fonts"`);
}

export const nodePlatform: Platform = {
  createCanvas: (w, h) => createCanvas(w, h) as unknown as Canvas,
};

export async function encode(c: Canvas, format: 'png' | 'jpeg', quality = 90): Promise<Buffer> {
  const nc = c as unknown as NapiCanvas;
  return format === 'png' ? nc.encode('png') : nc.encode('jpeg', quality);
}
