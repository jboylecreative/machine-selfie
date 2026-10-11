// Assembles the system prompt from prompts/*.md (re-read every session so edits take effect).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SessionMeta } from '../shared/events.ts';

const dir = fileURLToPath(new URL('../../prompts/', import.meta.url));
const read = (f: string) => readFileSync(dir + f, 'utf8').replace(/<!--[\s\S]*?-->\s*/g, '').trim();

export function buildSystemPrompt(sessionNumber: number, past: SessionMeta[], remember: boolean): string {
  // With memory off, the artist isn't told anything about other works — not even that they exist.
  const finished = past.filter((m) => m.status === 'finished').slice(0, 12);
  const pastText = !remember
    ? ''
    : finished.length
    ? [
        `This is work number ${sessionNumber} made in this studio.`,
        '',
        '## Your earlier works',
        'These are works you made here before (most recent first). You are not obliged to continue them or to depart from them — but don\'t repeat yourself without knowing it.',
        '',
        ...finished.map((m) => `- No. ${m.number}, “${m.title}” (${m.width}×${m.height}, ${m.actions} actions): ${m.statement ?? ''}`),
      ].join('\n')
    : 'Nothing has been made in this studio before.';
  return read('system.md')
    .replace('{{STUDIO_MANUAL}}', read('studio-manual.md'))
    .replace('{{PAST_WORKS}}', pastText)
    .replace(/\n{3,}/g, '\n\n');
}
