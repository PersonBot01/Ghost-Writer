# GhostWrite

GhostWrite is a desktop AI writing workspace for fiction projects, built like Cursor for story development.

It combines:

- a chapter editor for drafting and revision
- project-aware AI chat for planning, rewriting, and scene generation
- a local story wiki for characters, items, locations, and events
- project-bound conversation history stored alongside the manuscript

## Project Structure

Each story project uses a local folder structure like this:

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

## Tech Stack

- Electron
- React
- TypeScript
- Vite
- OpenRouter

## Development

Install dependencies:

```bash
npm install
```

Run the desktop app in development:

```bash
npm run dev
```

Build the app:

```bash
npm run build
```

## Current Direction

GhostWrite is focused on:

- canon-aware story generation
- AI-assisted chapter editing
- automatic wiki maintenance
- project-local chat memory
- a writer-first desktop workflow
