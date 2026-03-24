const { contextBridge, ipcRenderer } = require('electron')

const api = {
  openProject: () => ipcRenderer.invoke('project:open'),
  listProjectTree: (rootPath: string) => ipcRenderer.invoke('project:list-tree', rootPath),
  readChapter: (targetPath: string) => ipcRenderer.invoke('chapter:read', targetPath),
  writeChapter: (targetPath: string, content: string) =>
    ipcRenderer.invoke('chapter:write', targetPath, content),
  writeChapterPatch: (targetPath: string, nextContent: string) =>
    ipcRenderer.invoke('chapter:write-patch', targetPath, nextContent),
  createChapter: (rootPath: string, title: string) =>
    ipcRenderer.invoke('chapter:create', rootPath, title),
  readWikiEntry: (targetPath: string) => ipcRenderer.invoke('wiki:read', targetPath),
  createWikiEntry: (
    rootPath: string,
    type: string,
    name: string,
    description?: string,
  ) => ipcRenderer.invoke('wiki:create', rootPath, type, name, description),
  updateWikiEntry: (targetPath: string, entry: unknown) =>
    ipcRenderer.invoke('wiki:update', targetPath, entry),
  createConversation: (rootPath: string, title: string) =>
    ipcRenderer.invoke('conversation:create', rootPath, title),
  readConversation: (targetPath: string) => ipcRenderer.invoke('conversation:read', targetPath),
  appendConversationMessage: (targetPath: string, message: unknown) =>
    ipcRenderer.invoke('conversation:append', targetPath, message),
  removeLastAssistantMessage: (targetPath: string) =>
    ipcRenderer.invoke('conversation:remove-last-assistant', targetPath),
  renameNode: (targetPath: string, kind: string, nextName: string) =>
    ipcRenderer.invoke('fs:rename', targetPath, kind, nextName),
  deleteNode: (targetPath: string) => ipcRenderer.invoke('fs:delete', targetPath),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings: unknown) => ipcRenderer.invoke('settings:save', settings),
  chatWithAI: (request: unknown) => ipcRenderer.invoke('ai:chat', request),
  generateChapterPatch: (request: unknown) => ipcRenderer.invoke('ai:patch', request),
  generateCanonSync: (request: unknown) => ipcRenderer.invoke('ai:canon-sync', request),
}

contextBridge.exposeInMainWorld('ghostwrite', api)
