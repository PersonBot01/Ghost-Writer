import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chatWithAI, generateCanonSync, generateChapterPatch } from './services/ai-service.js'
import {
  appendConversationMessage,
  createChapter,
  createConversation,
  createWikiEntry,
  deleteNode,
  ensureProjectStructure,
  listProjectTree,
  removeLastAssistantMessage,
  readChapter,
  readConversation,
  readWikiEntry,
  renameNode,
  updateWikiEntry,
  writeChapter,
} from './services/project-service.js'
import {
  DEFAULT_SYSTEM_PROMPT,
  type AppSettings,
  type WikiEntry,
  WIKI_TYPES,
} from '../src/shared/types.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DEFAULT_SETTINGS: AppSettings = {
  apiKey: '',
  model: 'nvidia/nemotron-3-super-120b-a12b:free',
  baseUrl: 'https://openrouter.ai/api/v1',
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1200,
    minHeight: 760,
    backgroundColor: '#101312',
    title: 'GhostWrite',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  const devServerUrl = process.env.VITE_DEV_SERVER_URL
  if (devServerUrl) {
    void win.loadURL(devServerUrl)
  } else {
    void win.loadFile(path.join(__dirname, '../../dist/index.html'))
  }
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

function registerIpc() {
  ipcMain.handle('project:open', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Open or create a story project',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return ensureProjectStructure(result.filePaths[0])
  })

  ipcMain.handle('project:list-tree', async (_event, rootPath: string) => {
    return listProjectTree(rootPath)
  })

  ipcMain.handle('chapter:read', async (_event, targetPath: string) => {
    return readChapter(targetPath)
  })

  ipcMain.handle('chapter:write', async (_event, targetPath: string, content: string) => {
    return writeChapter(targetPath, content)
  })

  ipcMain.handle('chapter:write-patch', async (_event, targetPath: string, nextContent: string) => {
    return writeChapter(targetPath, nextContent)
  })

  ipcMain.handle('chapter:create', async (_event, rootPath: string, title: string) => {
    return createChapter(rootPath, title)
  })

  ipcMain.handle('wiki:read', async (_event, targetPath: string) => {
    return readWikiEntry(targetPath)
  })

  ipcMain.handle(
    'wiki:create',
    async (_event, rootPath: string, type: string, name: string, description?: string) => {
      if (!WIKI_TYPES.includes(type as (typeof WIKI_TYPES)[number])) {
        throw new Error(`Unsupported wiki type: ${type}`)
      }
      return createWikiEntry(rootPath, type as (typeof WIKI_TYPES)[number], name, description)
    },
  )

  ipcMain.handle('wiki:update', async (_event, targetPath: string, entry: WikiEntry) => {
    return updateWikiEntry(targetPath, entry)
  })

  ipcMain.handle('conversation:create', async (_event, rootPath: string, title: string) => {
    return createConversation(rootPath, title)
  })

  ipcMain.handle('conversation:read', async (_event, targetPath: string) => {
    return readConversation(targetPath)
  })

  ipcMain.handle('conversation:append', async (_event, targetPath: string, message) => {
    return appendConversationMessage(targetPath, message)
  })

  ipcMain.handle('conversation:remove-last-assistant', async (_event, targetPath: string) => {
    return removeLastAssistantMessage(targetPath)
  })

  ipcMain.handle('fs:rename', async (_event, targetPath: string, kind, nextName: string) => {
    return renameNode(targetPath, kind, nextName)
  })

  ipcMain.handle('fs:delete', async (_event, targetPath: string) => {
    return deleteNode(targetPath)
  })

  ipcMain.handle('settings:get', async () => {
    return getSettings()
  })

  ipcMain.handle('settings:save', async (_event, settings: AppSettings) => {
    return saveSettings(settings)
  })

  ipcMain.handle('ai:chat', async (_event, request) => {
    return chatWithAI(request, await getSettings())
  })

  ipcMain.handle('ai:patch', async (_event, request) => {
    return generateChapterPatch(request, await getSettings())
  })

  ipcMain.handle('ai:canon-sync', async (_event, request) => {
    return generateCanonSync(request, await getSettings())
  })
}

async function getSettings(): Promise<AppSettings> {
  const settingsPath = await resolveSettingsPath()
  try {
    const raw = await readFile(settingsPath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<AppSettings>
    return {
      apiKey: parsed.apiKey ?? process.env.OPENROUTER_API_KEY ?? DEFAULT_SETTINGS.apiKey,
      model: parsed.model ?? DEFAULT_SETTINGS.model,
      baseUrl: parsed.baseUrl ?? DEFAULT_SETTINGS.baseUrl,
      systemPrompt: parsed.systemPrompt ?? DEFAULT_SETTINGS.systemPrompt,
    }
  } catch {
    return {
      ...DEFAULT_SETTINGS,
      apiKey: process.env.OPENROUTER_API_KEY ?? DEFAULT_SETTINGS.apiKey,
    }
  }
}

async function saveSettings(settings: AppSettings): Promise<AppSettings> {
  const settingsPath = await resolveSettingsPath()
  const nextSettings: AppSettings = {
    apiKey: settings.apiKey.trim(),
    model: settings.model.trim() || DEFAULT_SETTINGS.model,
    baseUrl: settings.baseUrl.trim() || DEFAULT_SETTINGS.baseUrl,
    systemPrompt: settings.systemPrompt.trim() || DEFAULT_SETTINGS.systemPrompt,
  }
  await writeFile(settingsPath, `${JSON.stringify(nextSettings, null, 2)}\n`, 'utf8')
  return nextSettings
}

async function resolveSettingsPath() {
  const userData = app.getPath('userData')
  await mkdir(userData, { recursive: true })
  return path.join(userData, 'ghostwrite-settings.json')
}
