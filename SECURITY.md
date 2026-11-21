# Security

Please report security problems privately, through **Report a vulnerability** in this repository's
Security tab, not in a public issue.

Worth reporting, for example:

- anything that could read the AI keys the tone assistant keeps in the browser, or send them anywhere
  but Groq and Google;
- a way for a web page, a preset file, a backup file or a TONE3000 download to make the editor write
  to the pedal without the person's click;
- anything in the desktop app's update path that could install something other than this
  repository's GitHub release.

## What the editor keeps, and where

There is no server. The editor and the desktop app talk only to the pedal, to TONE3000 (when you
use it), and to the AI provider whose key you added. In the browser's storage for the site (or the
desktop app), and nowhere else, it keeps:

| What | Storage key |
|---|---|
| Backups made before each save | `pocket-master-editor.backups.v1` |
| Groq and Gemini keys, if you added them | `pocket-master-editor.groqKey.v1`, `pocket-master-editor.geminiKey.v1` |
| How many assistant requests were sent today | `pocket-master-editor.geminiUsage.v1` |
| Your preset library | `pocket-master-editor.presetLibrary.v1` |
| Notes on slots | `pocket-master-editor.slotNotes.v1` |
| Your TONE3000 sign-in, if you signed in | `pocket-master-editor.tone3000` |
| Theme, language, and whether the MIDI log is shown | `pocket-master-editor.theme`, `.lang`, `.showLog` |

Clearing the site's data in the browser removes all of it. The tone assistant sends your messages
and the loaded preset to the provider that answers; on free plans the provider may use them to
improve its products (the panel says so before a key is saved).
