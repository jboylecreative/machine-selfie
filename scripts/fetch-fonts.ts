// Downloads the studio's typefaces (all SIL Open Font License) into public/fonts.
// The same files are registered on the server renderer and loaded by viewers' browsers,
// so text looks identical to the artist and to the audience.
import { mkdir, writeFile, access } from 'node:fs/promises';
import { FONTS } from '../src/engine/fonts.ts';

const dir = new URL('../public/fonts/', import.meta.url);
await mkdir(dir, { recursive: true });

for (const font of FONTS) {
  for (const weight of font.weights) {
    for (const style of font.italic ? ['normal', 'italic'] : ['normal']) {
      const file = `${font.id}-${weight}-${style}.ttf`;
      const target = new URL(file, dir);
      try { await access(target); continue; } catch {}
      const url = `https://cdn.jsdelivr.net/fontsource/fonts/${font.id}@latest/latin-${weight}-${style}.ttf`;
      const res = await fetch(url);
      if (!res.ok) { console.warn(`  ! ${file}: HTTP ${res.status}`); continue; }
      await writeFile(target, Buffer.from(await res.arrayBuffer()));
      console.log(`  ✓ ${file}`);
    }
  }
}
console.log('fonts ready');
