// Standalone check of the turn format (does not touch the archive or a running studio):
// tool results go back as functionResponse parts only, with the canvas image attached
// inside the last function response. Prints what the model emits each turn.
import 'dotenv/config';
import { GoogleGenAI, type Content, type FunctionCall, type Part } from '@google/genai';
import { StudioDocument } from '../src/engine/document.ts';
import { TOOL_DECLARATIONS, executeTool, type ToolContext } from '../src/server/tools.ts';
import { buildSystemPrompt } from '../src/server/prompt.ts';
import { encode, loadFonts, nodePlatform } from '../src/server/platform.ts';

const TURNS = Number(process.argv[2] ?? 4);
loadFonts();
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
const model = process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview';
const doc = new StudioDocument(nodePlatform);
let n = 0;
const ctx: ToolContext = { doc, emit: (op) => doc.apply(op), nextLayerId: () => `L${++n}`, seed: () => (Math.random() * 2 ** 32) >>> 0, random: Math.random };
const jpeg = async () => (await encode(doc.flatten('#ffffff', 1024), 'jpeg', 88)).toString('base64');

const history: Content[] = [{ role: 'user', parts: [
  { text: `The studio is open. ${new Date().toUTCString()}.\n${doc.describe()}\nNothing is required of you. Begin whenever, and however, you choose.` },
  { inlineData: { mimeType: 'image/jpeg', data: await jpeg() } },
] }];

for (let turn = 1; turn <= TURNS; turn++) {
  const res = await ai.models.generateContent({
    model, contents: history,
    config: { systemInstruction: buildSystemPrompt(1, [], false), temperature: 1, tools: [{ functionDeclarations: TOOL_DECLARATIONS }], thinkingConfig: { includeThoughts: true } },
  });
  const parts: Part[] = res.candidates?.[0]?.content?.parts ?? [];
  history.push({ role: 'model', parts });
  const thought = parts.filter((p) => p.thought && p.text).map((p) => p.text).join('');
  const speech = parts.filter((p) => !p.thought && p.text).map((p) => p.text).join('');
  const calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall!) as FunctionCall[];
  console.log(`\n--- turn ${turn}: ${calls.length} calls [${calls.map((c) => c.name).join(', ')}]`);
  console.log(`thought (${thought.length} chars): ${thought.slice(0, 160).replace(/\n/g, ' ')}`);
  console.log(`speech: ${JSON.stringify(speech.slice(0, 200))}`);
  if (!calls.length) { history.push({ role: 'user', parts: [{ text: '(Continue with the tools, or call finish.)' }] }); continue; }
  const responses: Part[] = [];
  for (const [i, c] of calls.entries()) {
    let response: Record<string, unknown>;
    try { response = executeTool(c.name!, (c.args ?? {}) as Record<string, unknown>, ctx).response; }
    catch (e) { response = { error: (e as Error).message }; }
    const last = i === calls.length - 1;
    if (last) response = { ...response, studio: `Turn ${turn} complete. ${doc.describe()}`, canvas: 'The attached image shows the canvas as it now is.' };
    responses.push({ functionResponse: { id: c.id, name: c.name, response, ...(last ? { parts: [{ inlineData: { mimeType: 'image/jpeg', data: await jpeg() } }] } : {}) } });
  }
  history.push({ role: 'user', parts: responses });
}
