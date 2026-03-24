# GhostWrite

GhostWrite is a desktop AI writing workspace for fiction projects, built like Cursor for story development.

It combines a local chapter editor, project-aware AI chat, and a living story wiki so writers can draft scenes, revise prose, direct the story, and keep canon synchronized as the manuscript evolves.

## What It Does

- Edit chapters locally in a desktop writing workspace
- Chat with AI for planning, scene generation, rewrites, and continuity work
- Store project conversations inside the project folder
- Maintain a story wiki for characters, items, locations, and events
- Sync wiki entries from AI output or by scanning a chapter
- Apply AI edits to selected text or whole chapters

## Project Layout

Each story project uses this structure:

```text
project/
  chapters/
  conversations/
  wiki/
    characters/
    items/
    locations/
    events/
```

- `chapters/` stores story chapters as Markdown files
- `conversations/` stores project chat sessions as `.jsonl`
- `wiki/` stores canon as JSON entries grouped by type

## Tech Stack

- Electron
- React
- TypeScript
- Vite
- OpenRouter

## Getting Started

### 1. Install dependencies

```bash
npm install
```

### 2. Run the desktop app

```bash
npm run dev
```

This starts the Vite renderer, the Electron TypeScript watcher, and the desktop app shell.

### 3. Configure AI

Open `Settings` inside GhostWrite and add:

- your OpenRouter API key
- the model you want to use
- an optional custom system prompt

## Available Scripts

```bash
npm run dev
npm run dev:web
npm run build
npm run lint
npm start
```

## Current Workflow

GhostWrite currently supports:

- opening a local story project folder
- creating and editing chapters
- creating and editing wiki entries
- project-bound AI conversations
- right-click AI edits for selected text
- regenerate and retry flows for AI responses
- chapter-to-wiki sync

## Notes

- GhostWrite is desktop-first and intended to run inside Electron
- the browser-only Vite preview does not provide filesystem access
- AI quality and latency depend on the configured OpenRouter model

## License

MIT
