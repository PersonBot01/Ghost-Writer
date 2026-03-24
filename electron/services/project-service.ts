import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import {
  type ConversationMessage,
  type ConversationSession,
  type ConversationSessionMeta,
  type FileDocument,
  type ProjectInfo,
  type TreeNode,
  type TreeNodeKind,
  type WikiDocument,
  type WikiEntry,
  type WikiType,
  WIKI_TYPES,
} from '../../src/shared/types.js'

const wikiEntrySchema = z.object({
  name: z.string(),
  type: z.enum(WIKI_TYPES),
  description: z.string(),
})

const conversationMetaSchema = z.object({
  kind: z.literal('session'),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const conversationMessageSchema = z.object({
  kind: z.literal('message'),
  role: z.enum(['user', 'assistant', 'system']),
  timestamp: z.string(),
  content: z.string(),
  chapterPatch: z
    .object({
      target: z.enum(['chapter', 'selection']),
      summary: z.string(),
      originalText: z.string(),
      updatedText: z.string(),
      nextContent: z.string(),
    })
    .nullable()
    .optional(),
  wikiCreates: z
    .array(
      z.object({
        action: z.enum(['create', 'update']),
        path: z.string(),
        entry: wikiEntrySchema,
        reason: z.string(),
        sourceEvidence: z.array(z.string()),
      }),
    )
    .optional(),
  wikiUpdates: z
    .array(
      z.object({
        action: z.enum(['create', 'update']),
        path: z.string(),
        entry: wikiEntrySchema,
        reason: z.string(),
        sourceEvidence: z.array(z.string()),
      }),
    )
    .optional(),
  conflicts: z
    .array(
      z.object({
        entityName: z.string(),
        message: z.string(),
        existingPath: z.string().optional(),
        sourceEvidence: z.array(z.string()),
      }),
    )
    .optional(),
})

const PROJECT_FOLDERS = ['chapters', 'conversations', 'wiki'] as const

const WIKI_FOLDERS: Record<WikiType, string> = {
  character: 'characters',
  item: 'items',
  location: 'locations',
  event: 'events',
}

export async function ensureProjectStructure(rootPath: string): Promise<ProjectInfo> {
  await mkdir(rootPath, { recursive: true })
  await Promise.all(
    PROJECT_FOLDERS.map(async (folder) => {
      await mkdir(path.join(rootPath, folder), { recursive: true })
    }),
  )

  await Promise.all(
    Object.values(WIKI_FOLDERS).map(async (folder) => {
      await mkdir(path.join(rootPath, 'wiki', folder), { recursive: true })
    }),
  )

  return {
    rootPath,
    name: path.basename(rootPath),
    tree: await listProjectTree(rootPath),
  }
}

export async function listProjectTree(rootPath: string): Promise<TreeNode> {
  const root: TreeNode = {
    id: rootPath,
    kind: 'root',
    name: path.basename(rootPath),
    path: rootPath,
    children: [],
  }

  const chaptersPath = path.join(rootPath, 'chapters')
  const conversationsPath = path.join(rootPath, 'conversations')
  const wikiPath = path.join(rootPath, 'wiki')

  root.children = [
    await buildDirectoryNode(chaptersPath, 'folder', 'Chapters', ['.md'], 'chapter'),
    await buildDirectoryNode(
      conversationsPath,
      'folder',
      'Conversations',
      ['.jsonl'],
      'conversation',
    ),
    {
      id: wikiPath,
      kind: 'folder',
      name: 'Wiki',
      path: wikiPath,
      children: await Promise.all(
        WIKI_TYPES.map(async (type) => {
          const categoryPath = path.join(wikiPath, WIKI_FOLDERS[type])
          return buildDirectoryNode(
            categoryPath,
            'wikiCategory',
            capitalize(type) + 's',
            ['.json'],
            'wikiEntry',
            type,
          )
        }),
      ),
    },
  ]

  return root
}

export async function readChapter(chapterPath: string): Promise<FileDocument> {
  const content = await readFile(chapterPath, 'utf8')
  return { path: chapterPath, content }
}

export async function writeChapter(chapterPath: string, content: string): Promise<FileDocument> {
  await writeFile(chapterPath, content, 'utf8')
  return { path: chapterPath, content }
}

export async function createChapter(rootPath: string, title: string): Promise<FileDocument> {
  const normalizedTitle = title.trim() || 'Untitled Chapter'
  const filePath = await createUniquePath(
    path.join(rootPath, 'chapters'),
    slugify(normalizedTitle) || 'untitled-chapter',
    '.md',
  )
  const content = `# ${normalizedTitle}\n\n`
  await writeFile(filePath, content, { encoding: 'utf8', flag: 'wx' })
  return { path: filePath, content }
}

export async function readWikiEntry(entryPath: string): Promise<WikiDocument> {
  const raw = await readFile(entryPath, 'utf8')
  const entry = wikiEntrySchema.parse(JSON.parse(raw))
  return { path: entryPath, ...entry }
}

export async function createWikiEntry(
  rootPath: string,
  type: WikiType,
  name: string,
  description = '',
): Promise<WikiDocument> {
  const entry: WikiEntry = {
    name: name.trim(),
    type,
    description,
  }
  const entryPath = resolveWikiPath(rootPath, entry)
  await writeFile(entryPath, `${JSON.stringify(entry, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  })
  return { path: entryPath, ...entry }
}

export async function updateWikiEntry(entryPath: string, entry: WikiEntry): Promise<WikiDocument> {
  wikiEntrySchema.parse(entry)
  await writeFile(entryPath, `${JSON.stringify(entry, null, 2)}\n`, 'utf8')
  return { path: entryPath, ...entry }
}

export async function listWikiDocuments(rootPath: string): Promise<WikiDocument[]> {
  const documents = await Promise.all(
    WIKI_TYPES.map(async (type) => {
      const folder = path.join(rootPath, 'wiki', WIKI_FOLDERS[type])
      const files = await safeReadDirectory(folder)
      const entries = await Promise.all(
        files
          .filter((entry) => entry.isFile() && path.extname(entry.name) === '.json')
          .map(async (entry) => readWikiEntry(path.join(folder, entry.name))),
      )
      return entries
    }),
  )

  return documents.flat()
}

export async function createConversation(
  rootPath: string,
  title: string,
): Promise<ConversationSession> {
  const normalizedTitle = title.trim() || 'New conversation'
  const timestamp = new Date().toISOString()
  const filePath = path.join(
    rootPath,
    'conversations',
    `${timestamp.slice(0, 19).replace(/[:T]/g, '-')}-${slugify(normalizedTitle)}.jsonl`,
  )
  const meta: ConversationSessionMeta = {
    kind: 'session',
    title: normalizedTitle,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  const content = `${JSON.stringify(meta)}\n`
  await writeFile(filePath, content, { encoding: 'utf8', flag: 'wx' })
  return { path: filePath, meta, messages: [] }
}

export async function readConversation(conversationPath: string): Promise<ConversationSession> {
  const raw = await readFile(conversationPath, 'utf8')
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  if (lines.length === 0) {
    throw new Error(`Conversation log is empty: ${conversationPath}`)
  }

  const meta = conversationMetaSchema.parse(JSON.parse(lines[0]))
  const messages = lines
    .slice(1)
    .map((line) => conversationMessageSchema.parse(JSON.parse(line)) as ConversationMessage)

  return {
    path: conversationPath,
    meta,
    messages,
  }
}

export async function appendConversationMessage(
  conversationPath: string,
  message: ConversationMessage,
): Promise<ConversationSession> {
  const session = await readConversation(conversationPath)
  const nextSession: ConversationSession = {
    ...session,
    meta: {
      ...session.meta,
      updatedAt: message.timestamp,
    },
    messages: [...session.messages, message],
  }
  await writeConversationSession(nextSession)
  return nextSession
}

export async function removeLastAssistantMessage(
  conversationPath: string,
): Promise<ConversationSession> {
  const session = await readConversation(conversationPath)
  const lastMessage = session.messages.at(-1)
  if (!lastMessage || lastMessage.role !== 'assistant') {
    return session
  }

  const nextSession: ConversationSession = {
    ...session,
    meta: {
      ...session.meta,
      updatedAt: new Date().toISOString(),
    },
    messages: session.messages.slice(0, -1),
  }
  await writeConversationSession(nextSession)
  return nextSession
}

export async function renameNode(
  targetPath: string,
  kind: TreeNodeKind,
  nextName: string,
): Promise<string> {
  const baseName = nextName.trim()
  if (!baseName) {
    throw new Error('A name is required.')
  }

  const directory = path.dirname(targetPath)
  let nextPath = targetPath

  if (kind === 'chapter') {
    nextPath = path.join(directory, `${slugify(baseName)}.md`)
  } else if (kind === 'wikiEntry') {
    const document = await readWikiEntry(targetPath)
    const renamedEntry: WikiEntry = { ...document, name: baseName }
    nextPath = path.join(directory, `${slugify(baseName)}.json`)
    await rename(targetPath, nextPath)
    await updateWikiEntry(nextPath, renamedEntry)
    return nextPath
  } else if (kind === 'conversation') {
    const session = await readConversation(targetPath)
    nextPath = path.join(
      directory,
      `${session.meta.createdAt.slice(0, 19).replace(/[:T]/g, '-')}-${slugify(baseName)}.jsonl`,
    )
    await rename(targetPath, nextPath)
    await writeConversationSession({
      ...session,
      path: nextPath,
      meta: {
        ...session.meta,
        title: baseName,
        updatedAt: new Date().toISOString(),
      },
    })
    return nextPath
  } else {
    nextPath = path.join(directory, baseName)
  }

  await rename(targetPath, nextPath)
  return nextPath
}

export async function deleteNode(targetPath: string): Promise<void> {
  const nodeStat = await stat(targetPath)
  if (nodeStat.isDirectory()) {
    await rm(targetPath, { recursive: true, force: true })
    return
  }

  await rm(targetPath, { force: true })
}

export function resolveWikiPath(rootPath: string, entry: WikiEntry): string {
  return path.join(rootPath, 'wiki', WIKI_FOLDERS[entry.type], `${slugify(entry.name)}.json`)
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
}

async function buildDirectoryNode(
  folderPath: string,
  kind: TreeNodeKind,
  label: string,
  extensions: string[],
  childKind: TreeNodeKind,
  wikiType?: WikiType,
): Promise<TreeNode> {
  const entries = await safeReadDirectory(folderPath)
  const children = entries
    .filter((entry) => entry.isFile() && extensions.includes(path.extname(entry.name)))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => ({
      id: path.join(folderPath, entry.name),
      kind: childKind,
      name: childKind === 'conversation' ? trimConversationLabel(entry.name) : path.parse(entry.name).name,
      path: path.join(folderPath, entry.name),
      wikiType,
    }))

  return {
    id: folderPath,
    kind,
    name: label,
    path: folderPath,
    children,
    wikiType,
  }
}

async function safeReadDirectory(folderPath: string) {
  try {
    return await readdir(folderPath, { withFileTypes: true })
  } catch {
    return []
  }
}

async function writeConversationSession(session: ConversationSession): Promise<void> {
  const lines = [
    JSON.stringify(session.meta),
    ...session.messages.map((message) => JSON.stringify(message)),
  ]
  await writeFile(session.path, `${lines.join('\n')}\n`, 'utf8')
}

async function createUniquePath(directory: string, baseName: string, extension: string) {
  let attempt = 0

  while (attempt < 500) {
    const suffix = attempt === 0 ? '' : `-${attempt + 1}`
    const candidate = path.join(directory, `${baseName}${suffix}${extension}`)
    try {
      await stat(candidate)
      attempt += 1
    } catch {
      return candidate
    }
  }

  throw new Error(`Could not allocate a unique file name for ${baseName}${extension}.`)
}

function trimConversationLabel(fileName: string): string {
  return fileName
    .replace(/^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-/, '')
    .replace(/\.jsonl$/, '')
    .replace(/-/g, ' ')
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}
