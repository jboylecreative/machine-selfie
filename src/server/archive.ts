// Every session is archived to data/sessions/<id>/: events.jsonl (full replay), meta.json, final.png, thumb.jpg.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SessionMeta, StudioEvent } from '../shared/events.ts';

// The archive must live on persistent storage when hosted: DATA_DIR if set, otherwise a
// Railway volume if one is attached, otherwise ./data.
const dataEnv = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH;
export const DATA_DIR = dataEnv ? resolve(dataEnv) : fileURLToPath(new URL('../../data/', import.meta.url));
const SESSIONS = join(DATA_DIR, 'sessions');

export class Archive {
  constructor() { mkdirSync(SESSIONS, { recursive: true }); }

  list(): SessionMeta[] {
    return readdirSync(SESSIONS, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(SESSIONS, d.name, 'meta.json')))
      .map((d) => JSON.parse(readFileSync(join(SESSIONS, d.name, 'meta.json'), 'utf8')) as SessionMeta)
      .sort((a, b) => b.number - a.number);
  }

  nextNumber(): number {
    return (this.list()[0]?.number ?? 0) + 1;
  }

  dir(id: string): string {
    if (!/^[\w-]+$/.test(id)) throw new Error('bad session id');
    return join(SESSIONS, id);
  }

  create(meta: SessionMeta) {
    const dir = this.dir(meta.id);
    mkdirSync(dir, { recursive: true });
    const w = {
      meta,
      event: (e: StudioEvent) => appendFileSync(join(dir, 'events.jsonl'), JSON.stringify(e) + '\n'),
      saveMeta: () => writeFileSync(join(dir, 'meta.json'), JSON.stringify(w.meta, null, 2)),
      saveFile: (name: string, data: Buffer | string) => writeFileSync(join(dir, name), data),
    };
    w.saveMeta();
    return w;
  }

  events(id: string): StudioEvent[] {
    const file = join(this.dir(id), 'events.jsonl');
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  file(id: string, name: string): Buffer | null {
    const file = join(this.dir(id), name);
    return existsSync(file) ? readFileSync(file) : null;
  }
}
