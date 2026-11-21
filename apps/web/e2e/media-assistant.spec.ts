import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, connect } from './fixtures.ts';

// README media for the tone assistant: a simulated pedal and a simulated Gemini (nothing goes to
// Google). Runs only on request, with Google Chrome (the knobs' gradients) and ffmpeg (the GIF):
//   MEDIA=1 npx playwright test e2e/media-assistant.spec.ts
test.skip(!process.env.MEDIA, 'set MEDIA=1 to regenerate docs/media/assistant.*');
const OUT = new URL('../../../docs/media/', import.meta.url).pathname;
const VIDEO = mkdtempSync(join(tmpdir(), 'assistant-media-'));
test.use({ channel: 'chrome', viewport: { width: 1280, height: 1250 }, deviceScaleFactor: 1, colorScheme: 'dark', video: { mode: 'on', size: { width: 1280, height: 1250 } } });
test.setTimeout(120_000);

const REPLY = 'Built it: Calif DualM (a Mesa Dual Rectifier) with gain 70 and a scooped middle, the Dual 4x12 cab and a little room reverb. Ask for more bass or less gain by ear, or "save it on P45".';

test('assistant media', async ({ page, pedal }) => {
  mkdirSync(OUT, { recursive: true });
  const replies = [
    { status: 'requires_action', steps: [{ type: 'function_call', id: 'c1', name: 'edit_preset', arguments: { changes: [
      { kind: 'model', block: 'AMP', model: 'Calif DualM' }, { kind: 'parameter', block: 'AMP', parameter: 'Gain', value: 70 },
      { kind: 'parameter', block: 'AMP', parameter: 'Middle', value: 35 }, { kind: 'model', block: 'IR', model: 'Dual 4x12' },
      { kind: 'model', block: 'RVB', model: 'Room' }, { kind: 'block', block: 'RVB', on: true },
    ] } }] },
    { status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: REPLY }] }] },
  ];
  await page.route('https://generativelanguage.googleapis.com/**', async (route) => {
    if (route.request().url().includes('/models')) return route.fulfill({ json: { models: [] } });
    await new Promise((r) => setTimeout(r, 900)); // the model thinking
    return route.fulfill({ json: replies.shift() });
  });
  await connect(page, pedal);
  // The toolbar floats over the page when scrolled; in a still frame it would cover the amp's header.
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; } .toolbar { position: static !important; }' });
  await page.getByRole('switch', { name: 'Live edit' }).click();
  const panel = page.getByRole('region', { name: 'Tone assistant' });
  const setup = panel.getByRole('region', { name: 'Google Gemini key' });
  await setup.getByLabel('Gemini API key').fill('AIzaTESTKEY-media-000000000000000000000');
  await setup.getByRole('button', { name: 'Save key' }).click();
  await page.evaluate(() => document.fonts.ready);

  // Frame: the amp's faceplate down to the chat.
  const amp = page.locator('section.block-amp');
  await amp.evaluate((e) => window.scrollTo(0, e.getBoundingClientRect().top + window.scrollY - 16));
  const start = Date.now();
  await page.waitForTimeout(800);
  await panel.getByRole('button', { name: 'Black Album rhythm tone' }).click(); // a first-time user starts from an example
  await page.waitForTimeout(900);
  await panel.getByRole('button', { name: 'Send' }).click();
  await panel.getByText(REPLY).waitFor();
  await page.waitForTimeout(2500); // the tube warms up, the reader reads
  const seconds = (Date.now() - start) / 1000 + 0.5;

  const a = (await amp.boundingBox())!;
  const p = (await panel.boundingBox())!;
  const clip = { x: a.x, y: a.y, width: a.width, height: Math.min(p.y + p.height, 1250) - a.y };
  await page.screenshot({ path: join(OUT, 'assistant.jpg'), type: 'jpeg', quality: 86, clip });

  const video = page.video()!;
  await page.close();
  const webm = await video.path();
  const crop = `crop=${Math.round(clip.width)}:${Math.round(clip.height)}:${Math.round(clip.x)}:${Math.round(clip.y)}`;
  const palette = join(VIDEO, 'palette.png');
  const filters = `${crop},fps=12,scale=720:-1:flags=lanczos`;
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-sseof', `-${seconds.toFixed(1)}`, '-i', webm, '-vf', `${filters},palettegen=max_colors=128`, palette]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-sseof', `-${seconds.toFixed(1)}`, '-i', webm, '-i', palette, '-lavfi', `${filters}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4`, join(OUT, 'assistant.gif')]);
  rmSync(VIDEO, { recursive: true, force: true });
  console.log(readdirSync(OUT).filter((f) => f.startsWith('assistant')));
});
