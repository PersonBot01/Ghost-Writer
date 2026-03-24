export const WIKI_TYPES = ['character', 'item', 'location', 'event'] as const

export type WikiType = (typeof WIKI_TYPES)[number]

export interface WikiEntry {
  name: string
  type: WikiType
  description: string
}

export interface WikiDocument extends WikiEntry {
  path: string
}

export type TreeNodeKind =
  | 'root'
  | 'folder'
  | 'chapter'
  | 'wikiCategory'
  | 'wikiEntry'
  | 'conversation'

export interface TreeNode {
  id: string
  kind: TreeNodeKind
  name: string
  path: string
  children?: TreeNode[]
  wikiType?: WikiType
}

export interface ProjectInfo {
  rootPath: string
  name: string
  tree: TreeNode
}

export interface ConversationSessionMeta {
  kind: 'session'
  title: string
  createdAt: string
  updatedAt: string
}

export interface WikiChangeProposal {
  action: 'create' | 'update'
  path: string
  entry: WikiEntry
  reason: string
  sourceEvidence: string[]
}

export interface CanonConflict {
  entityName: string
  message: string
  existingPath?: string
  sourceEvidence: string[]
}

export interface ChapterPatch {
  target: 'chapter' | 'selection'
  summary: string
  originalText: string
  updatedText: string
  nextContent: string
}

export interface ConversationMessage {
  kind: 'message'
  role: 'user' | 'assistant' | 'system'
  timestamp: string
  content: string
  chapterPatch?: ChapterPatch | null
  wikiCreates?: WikiChangeProposal[]
  wikiUpdates?: WikiChangeProposal[]
  conflicts?: CanonConflict[]
}

export interface ConversationSession {
  path: string
  meta: ConversationSessionMeta
  messages: ConversationMessage[]
}

export interface TextSelection {
  start: number
  end: number
  text: string
}

export interface AppSettings {
  apiKey: string
  model: string
  baseUrl: string
  systemPrompt: string
}

export const DEFAULT_SYSTEM_PROMPT = [
  'You are GhostWrite, an editorial AI for fiction projects.',
  'Prioritize continuity, clarity, and useful collaboration.',
  'Use the project wiki as authoritative canon whenever relevant.',
  'If canon does not support a detail, avoid presenting it as settled fact.',
  'Be concrete, actionable, and concise unless the user asks for more detail.',
].join('\n')

export interface ChatRequest {
  projectRoot: string
  instruction: string
  sourceText: string
  chapterPath?: string
  selection?: TextSelection | null
  conversation?: ConversationSession | null
  thinkingMode?: boolean
}

export interface ChatResponse {
  assistantMessage: string
  chapterPatch: ChapterPatch | null
  wikiCreates: WikiChangeProposal[]
  wikiUpdates: WikiChangeProposal[]
  conflicts: CanonConflict[]
  referencedWikiPaths: string[]
}

export interface CanonSyncRequest {
  projectRoot: string
  storyText: string
  instruction: string
  referencedWikiPaths?: string[]
  thinkingMode?: boolean
}

export interface FileDocument {
  path: string
  content: string
}

export interface GhostwriteAPI {
  openProject: () => Promise<ProjectInfo | null>
  listProjectTree: (rootPath: string) => Promise<TreeNode>
  readChapter: (path: string) => Promise<FileDocument>
  writeChapter: (path: string, content: string) => Promise<FileDocument>
  writeChapterPatch: (path: string, nextContent: string) => Promise<FileDocument>
  createChapter: (rootPath: string, title: string) => Promise<FileDocument>
  readWikiEntry: (path: string) => Promise<WikiDocument>
  createWikiEntry: (
    rootPath: string,
    type: WikiType,
    name: string,
    description?: string,
  ) => Promise<WikiDocument>
  updateWikiEntry: (path: string, entry: WikiEntry) => Promise<WikiDocument>
  createConversation: (rootPath: string, title: string) => Promise<ConversationSession>
  readConversation: (path: string) => Promise<ConversationSession>
  appendConversationMessage: (
    path: string,
    message: ConversationMessage,
  ) => Promise<ConversationSession>
  removeLastAssistantMessage: (path: string) => Promise<ConversationSession>
  renameNode: (path: string, kind: TreeNodeKind, nextName: string) => Promise<string>
  deleteNode: (path: string) => Promise<void>
  getSettings: () => Promise<AppSettings>
  saveSettings: (settings: AppSettings) => Promise<AppSettings>
  chatWithAI: (request: ChatRequest) => Promise<ChatResponse>
  generateChapterPatch: (request: ChatRequest) => Promise<ChatResponse>
  generateCanonSync: (
    request: CanonSyncRequest,
  ) => Promise<Pick<ChatResponse, 'wikiCreates' | 'wikiUpdates' | 'conflicts'>>
}
