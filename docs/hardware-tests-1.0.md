# Hardware tests before 1.0

What only the real pedal can check (milestone 1.0.0). About an hour; a guitar is needed only
for step 4. Before anything: close SonicMaster and every other editor tab (another client on the
port steals replies), and keep a backup: the editor backs up each slot before writing it.

## 1. Read-only probe, 2 min

Pedal on USB, nothing else connected to it:

    node apps/mcp/scripts/probe-pedal.ts

It only reads. Besides the firmware version, it reads the loaded slot without loading it (a
command from klotznick's guide) and says whether that matches the edit buffer; if it does,
backups can stop loading each slot. Then run it once more with `--scan` (about a minute; it
also tries the battery and charge reads, which may only answer over Bluetooth). Send both log
files it prints at the end.

## 2. Global options (#90), 10 min

Web editor (or desktop app) over USB, gear button:
- The values shown match the pedal's own menus: master, levels, mode, EXP/FS type, backlight, ECO.
- Change one level, the backlight and ECO; check them on the pedal; put them back.
- Do not touch factory reset.

## 3. Bluetooth (#89), 15 min

Pedal's Bluetooth on, USB unplugged. In Chrome, *Connect via Bluetooth*:
- Computer: turn a knob with Live edit on and hear it; save to a spare slot (backup first, the
  default); restore that slot from the Backups panel.
- Switch the pedal off while connected: the editor says it disconnected.
- Android phone, Chrome, same site: connect, read the preset, turn a knob.

## 4. TONE3000 from the web editor (#91), 10 min

TONE3000 panel: sign in, search a capture, install it into an **empty** profile slot (slot 1
holds Randall SA). Pick it on AMP and play.

## 5. Phone layout (#92), 5 min

On the Android phone: the preset list folds behind its button, the arrows under the tiles move a
block in the chain, the model menu opens at the bottom of the screen.

## 6. Tone assistant with real keys (before 0.14.0), 15 min

Keys are typed in your own terminal and in the editor only: never in a chat, never in a file in
the project folder (the repository is public).

- Terminal, at the repository root: `GROQ_API_KEY=… GEMINI_API_KEY=… npm run e2e:live`. It
  checks each key and builds one tone per provider against the simulated pedal (a few of the
  day's free requests).
- Editor with the pedal on USB, Live edit on, Groq key added (Gemini too, if you like): click
  *Black Album rhythm tone*, Send. Play: the amp, cab and reverb change; *What changed* lists
  them; Undo (Cmd/Ctrl+Z) takes the whole change back.
- Write in Portuguese ("mais quente e com menos gain"): the answer comes in Portuguese and the
  sound changes.
- "ficou bom, guarda": the tone shows up in the preset library. *New conversation*, ask for the
  same tone: it loads the kept one instead of building it again.
- "salva no P45": the Save dialog opens filled in (P45 and a name). Cancel, or save to a spare
  slot (backup first, the default).

## 7. With Claude, if there is time, 10 min

Copying a preset to another slot and turning the tuner on and off are writes the guide
documents but this project has not tried. They are done together in the session, on a spare
slot, with a backup first.

Write down for each step: OK, or what happened. Each result closes its issue or turns into a fix.
