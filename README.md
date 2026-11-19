# Take Note

Nobody wants to take notes in meetings. Take Note records the meeting in Obsidian,
transcribes it **on your own computer** with Whisper, works out **who said what**, and has
an LLM of your choice turn it into a structured meeting note:

- 📋 **Summary** and ✅ **decisions**
- 📌 **Action items** as `- [ ]` tasks with owner, priority and 📅 due date (works with the Tasks plugin)
- ❓ **Open questions** and who to ask
- 🎫 **Tickets** (bug / feature / task / improvement) with acceptance criteria
- 🤖 **AI assignments**: work an AI assistant could do for you, each with a ready-to-paste prompt
- 👥 **By person**: what each person reported, committed to and asked
- ⚠️ Risks, 📝 facts worth remembering, 🔜 things to follow up next time

It also works without recording: write rough notes or paste a Zoom / Teams / Meet transcript,
then run one command.

```markdown
## 📌 Action items
- [ ] Send the API design template — [[Alice]] 📅 2026-11-21
- [ ] Investigate the checkout QR issue — [[Bob]]

## 👥 By person
### [[Dana]]
Ran the sync and approved the release plan.
- **Will do**
    - Review search options with the team next week
```

## Privacy

- **Audio never leaves your computer.** Recording, transcription (whisper.cpp) and speaker
  separation (sherpa-onnx) all run locally.
- **Only text is sent**, and only to the LLM endpoint *you* configure. Use a local model
  (Ollama, LM Studio) and nothing leaves your machine at all.
- Your API key is stored in your system keychain through Obsidian's secret storage, not in
  the vault.
- Voice fingerprints are stored in `~/.take-note/` on your computer, outside the vault,
  so they never sync. You can forget a voice from the settings at any time.
- Recording people may require their consent where you live. Tell people you are recording.

### Disclosures

As required by Obsidian's developer policies:

- **Network use.** The plugin only connects to the LLM server you set in **API base URL**,
  to list models and send your meeting text. It sends no telemetry and has no ads. The
  optional `scripts/setup-macos.sh` (which you run yourself, not the plugin) downloads
  Homebrew packages, the Whisper model from Hugging Face, and sherpa-onnx from npm and GitHub.
- **Files outside your vault.** It reads and writes `~/.take-note/` (speaker-separation
  runtime and models installed by the setup script, voice fingerprints, per-meeting speaker
  data), reads the Whisper model you configure (default `~/.cache/whisper/`), uses temporary
  files in your system temp folder while transcribing, and reads recordings you import.
- **Local programs.** It runs `ffmpeg`, `whisper-cli` and `node` from the paths in settings
  to convert, transcribe and separate speakers. It does not install or update anything itself.
- **Microphone.** Used only while you are recording.
- **Desktop only.** Needs the desktop app for the microphone, file system and local programs.

## Requirements

- Obsidian **desktop** 1.11.4 or newer
- An **OpenAI-compatible LLM**: a local one ([Ollama](https://ollama.com), [LM Studio](https://lmstudio.ai)),
  or a hosted API (OpenAI, OpenRouter, a LiteLLM / vLLM server…). A model with a large
  context window (32K+) gives the best results on long meetings.
- **macOS** for the one-step setup script (Apple Silicon or Intel). The plugin itself is
  plain Obsidian + Node, so Linux/Windows should work if you install ffmpeg, whisper.cpp and
  sherpa-onnx yourself and set their paths in settings. This is untested; reports welcome.

## Install

1. **Local speech tools** (macOS). Clone or download this repo, then run:

   ```bash
   ./scripts/setup-macos.sh
   ```

   This installs `ffmpeg` and `whisper.cpp` with Homebrew, downloads the multilingual
   Whisper model `large-v3-turbo-q5_0` (~574 MB), and installs sherpa-onnx plus two small
   speaker models (~80 MB) into `~/.take-note`. Add `--no-speakers` to skip speaker
   separation.

2. **The plugin.** Either:
   - **Manual:** download `main.js`, `manifest.json` and `styles.css` from the
     [latest release](https://github.com/stevelohwc/obsidian-take-note/releases/latest)
     into `<your vault>/.obsidian/plugins/take-note/`, or
   - **BRAT:** install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin and add
     `stevelohwc/obsidian-take-note`.

   Then reload Obsidian and enable **Take Note** in Settings → Community plugins.

3. **Settings → Take Note**
   - **API base URL**: e.g. `http://localhost:11434/v1` for Ollama.
   - **API key**: only if your server needs one.
   - **Model**: click **Test** to list the models your server offers.
   - **Your name**: so "I will…" in your notes becomes your action item.
   - **Extra instructions** (recommended): team context, such as who the initials in your notes
     are, client names and ticket conventions. It makes a big difference.
   - **Check Whisper setup** / **Check speaker setup** confirm the local tools are found.

## Use

| You want to… | Do this |
|---|---|
| Record a meeting | Click the 🎤 ribbon icon. Type your own notes under **My notes** while it records. Click the red timer in the status bar to stop. Transcript and AI notes appear automatically. |
| Only take rough notes | **New meeting note**, type, then run **Summarize & extract…** |
| Process a Zoom/Teams/Meet transcript | Paste it into a note and run **Summarize & extract…** |
| Process a recording file | **Import a recording…** (audio or video; it is not copied into the vault) |
| Re-run after editing your notes | Run **Summarize & extract…** again. It only replaces the AI section. |

All commands are in the command palette (Cmd/Ctrl+P) under "Take Note". You can assign
hotkeys to Start / Stop recording.

### Who said what

Transcripts are labelled by voice, like `[00:03:12] Alice: the release is ready…`. Voices it
has learned are named automatically, and new voices show as `Speaker 1`, `Speaker 2`…

- **After a meeting:** run **Name the speakers in this note**. You see two lines each voice said;
  type who it is. Their voice is remembered for next time. **Save & redo AI notes** regenerates
  the summary with the real names.
- **Or ahead of time:** run **Record a voice sample for a person** and have them read the text
  shown for about 20 seconds.
- **People notes:** with **Update People notes** on, each named speaker's `People/<Name>.md`
  gets a line like `- [[2026-11-19 – Weekly Sync]] — reported the release is ready`.
- **Accuracy:** set **Number of speakers** when you know it; that helps most. If people get
  mixed up, adjust **Voice match strictness** and **Separation sensitivity**.

### Online meetings with headphones

The microphone only hears you. To capture everyone, either use the meeting app's own
recording or transcript (then import or paste it), or route system audio into an input
device with a tool like [BlackHole](https://github.com/ExistentialAudio/BlackHole) and pick
that device under Settings → Microphone.

## How it works

| File | What it does |
|---|---|
| `src/recorder.ts` | Microphone → `.webm`, written to disk every second so a crash loses nothing |
| `src/transcribe.ts` | ffmpeg → whisper-cli, with speaker separation running in parallel |
| `helper/speakers.cjs` | sherpa-onnx speaker separation + voice fingerprints (runs in a Node subprocess) |
| `src/speakers.ts` | Merging split speakers, matching saved voices, labelling transcript lines |
| `src/llm.ts` | Streaming client for any OpenAI-compatible `/chat/completions` |
| `src/extract.ts` | The prompt, JSON parsing, splitting long meetings and merging, priority checks |
| `src/render.ts` | The Markdown written into your note |

Priorities are only kept when your notes or transcript actually contain an urgency word
(urgent, asap, blocker, today…) about that item. Models love to invent priorities otherwise.

## Development

```bash
npm install
npm test                                   # unit tests
npm run build                              # typecheck + build main.js
VAULTS="$HOME/path/to/vault" npm run deploy # build and copy into a vault
```

Test the pipeline without Obsidian:

```bash
LLM_MODEL=qwen2.5:14b node scripts/run.ts path/to/meeting.m4a   # or a .md file of notes
```

## Credits

[whisper.cpp](https://github.com/ggml-org/whisper.cpp) ·
[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) (pyannote segmentation, 3D-Speaker ERes2Net) ·
[Obsidian](https://obsidian.md)

## License

MIT
