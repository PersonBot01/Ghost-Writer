"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const { contextBridge, ipcRenderer } = require('electron');
const api = {
    openProject: () => ipcRenderer.invoke('project:open'),
    listProjectTree: (rootPath) => ipcRenderer.invoke('project:list-tree', rootPath),
    readChapter: (targetPath) => ipcRenderer.invoke('chapter:read', targetPath),
    writeChapter: (targetPath, content) => ipcRenderer.invoke('chapter:write', targetPath, content),
    writeChapterPatch: (targetPath, nextContent) => ipcRenderer.invoke('chapter:write-patch', targetPath, nextContent),
    createChapter: (rootPath, title) => ipcRenderer.invoke('chapter:create', rootPath, title),
    readWikiEntry: (targetPath) => ipcRenderer.invoke('wiki:read', targetPath),
    createWikiEntry: (rootPath, type, name, description) => ipcRenderer.invoke('wiki:create', rootPath, type, name, description),
    updateWikiEntry: (targetPath, entry) => ipcRenderer.invoke('wiki:update', targetPath, entry),
    createConversation: (rootPath, title) => ipcRenderer.invoke('conversation:create', rootPath, title),
    readConversation: (targetPath) => ipcRenderer.invoke('conversation:read', targetPath),
    appendConversationMessage: (targetPath, message) => ipcRenderer.invoke('conversation:append', targetPath, message),
    removeLastAssistantMessage: (targetPath) => ipcRenderer.invoke('conversation:remove-last-assistant', targetPath),
    renameNode: (targetPath, kind, nextName) => ipcRenderer.invoke('fs:rename', targetPath, kind, nextName),
    deleteNode: (targetPath) => ipcRenderer.invoke('fs:delete', targetPath),
    getSettings: () => ipcRenderer.invoke('settings:get'),
    saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
    chatWithAI: (request) => ipcRenderer.invoke('ai:chat', request),
    generateChapterPatch: (request) => ipcRenderer.invoke('ai:patch', request),
    generateCanonSync: (request) => ipcRenderer.invoke('ai:canon-sync', request),
};
contextBridge.exposeInMainWorld('ghostwrite', api);
