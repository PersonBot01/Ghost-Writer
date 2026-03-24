import { diffLines } from 'diff'
import { startTransition, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import type {
  AppSettings,
  ChapterPatch,
  ChatRequest,
  ChatResponse,
  ConversationMessage,
  ConversationSession,
  ProjectInfo,
  TextSelection,
  TreeNode,
  TreeNodeKind,
  WikiChangeProposal,
  WikiDocument,
  WikiType,
} from './shared/types'
import { DEFAULT_SYSTEM_PROMPT } from './shared/types'

const DEFAULT_SETTINGS: AppSettings = {
  apiKey: '',
  model: 'nvidia/nemotron-3-super-120b-a12b:free',
  baseUrl: 'https://openrouter.ai/api/v1',
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
}

type ActiveDocument =
  | { kind: 'chapter'; path: string }
  | { kind: 'wiki'; path: string }
  | null

interface FailedChatAttempt {
  conversationPath: string
  request: ChatRequest
}

interface SavedChatAttempt {
  conversationPath: string
  request: ChatRequest
}

interface PendingChapterDraft {
  suggestedTitle: string
  content: string
}

interface ContextMenuState {
  x: number
  y: number
  kind: 'tree' | 'editor-selection'
  node?: TreeNode
}

type ContextAction = 'new-chapter' | 'new-chat' | 'new-entry' | 'rename' | 'delete'

type AppDialog =
  | {
      kind: 'wiki'
      wikiType: WikiType
      name: string
      description: string
    }
  | {
      kind: 'conversation'
      title: string
    }
  | {
      kind: 'rename'
      targetPath: string
      targetKind: TreeNodeKind
      nextName: string
    }
  | {
      kind: 'delete'
      targetPath: string
      targetKind: TreeNodeKind
      label: string
    }
  | {
      kind: 'selection-ai'
      instruction: string
      selection: TextSelection
    }
  | null

function App() {
  const bridgeAvailable =
    typeof window !== 'undefined' &&
    typeof window.ghostwrite !== 'undefined' &&
    window.ghostwrite !== null
  const [project, setProject] = useState<ProjectInfo | null>(null)
  const [tree, setTree] = useState<TreeNode | null>(null)
  const [selectedNode, setSelectedNode] = useState<{ path: string; kind: TreeNodeKind } | null>(
    null,
  )
  const [activeDocument, setActiveDocument] = useState<ActiveDocument>(null)
  const [chapterContent, setChapterContent] = useState('')
  const [savedChapterContent, setSavedChapterContent] = useState('')
  const [wikiDocument, setWikiDocument] = useState<WikiDocument | null>(null)
  const [wikiDraft, setWikiDraft] = useState<WikiDocument | null>(null)
  const [activeConversation, setActiveConversation] = useState<ConversationSession | null>(null)
  const [chatInput, setChatInput] = useState('')
  const [selection, setSelection] = useState<TextSelection | null>(null)
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [showSettings, setShowSettings] = useState(false)
  const [pendingPatch, setPendingPatch] = useState<ChapterPatch | null>(null)
  const [wikiCreates, setWikiCreates] = useState<WikiChangeProposal[]>([])
  const [wikiUpdates, setWikiUpdates] = useState<WikiChangeProposal[]>([])
  const [conflicts, setConflicts] = useState<ChatResponse['conflicts']>([])
  const [referencedWikiPaths, setReferencedWikiPaths] = useState<string[]>([])
  const [status, setStatus] = useState('Pick a story project to start.')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastFailedChat, setLastFailedChat] = useState<FailedChatAttempt | null>(null)
  const [lastSuccessfulChat, setLastSuccessfulChat] = useState<SavedChatAttempt | null>(null)
  const [lastAppendedAssistantDraft, setLastAppendedAssistantDraft] = useState<ChapterPatch | null>(
    null,
  )
  const [pendingChapterDraft, setPendingChapterDraft] = useState<PendingChapterDraft | null>(null)
  const [dialogState, setDialogState] = useState<AppDialog>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [collapsedPaths, setCollapsedPaths] = useState<Record<string, boolean>>({})
  const [thinkingMode, setThinkingMode] = useState(true)
  const editorRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (!bridgeAvailable) {
      setStatus(
        'GhostWrite desktop bridge not detected. Open this in the Electron app, not the raw browser tab.',
      )
      return
    }
    void window.ghostwrite.getSettings().then(setSettings).catch(handleError)
  }, [bridgeAvailable])

  useEffect(() => {
    function handleWindowClick() {
      setContextMenu(null)
    }

    window.addEventListener('click', handleWindowClick)
    return () => window.removeEventListener('click', handleWindowClick)
  }, [])

  const chapterDirty = activeDocument?.kind === 'chapter' && chapterContent !== savedChapterContent
  const wikiDirty =
    activeDocument?.kind === 'wiki' &&
    wikiDocument &&
    wikiDraft &&
    JSON.stringify(wikiDraft) !== JSON.stringify(wikiDocument)

  const diffPreview = useMemo(() => {
    if (!pendingPatch) {
      return []
    }
    return diffLines(pendingPatch.originalText, pendingPatch.updatedText)
  }, [pendingPatch])

  async function handleOpenProject() {
    if (!bridgeAvailable) {
      setStatus('Open GhostWrite through Electron to access local projects.')
      return
    }
    try {
      setBusy('project')
      const nextProject = await window.ghostwrite.openProject()
      if (!nextProject) {
        return
      }
      setProject(nextProject)
      setTree(nextProject.tree)
      setActiveDocument(null)
      setActiveConversation(null)
      setPendingPatch(null)
      setWikiCreates([])
      setWikiUpdates([])
      setConflicts([])
      setReferencedWikiPaths([])
      setLastFailedChat(null)
      setLastSuccessfulChat(null)
      setLastAppendedAssistantDraft(null)
      setPendingChapterDraft(null)
      setCollapsedPaths({})
      setContextMenu(null)
      setStatus(`Project ready at ${nextProject.rootPath}`)

      const firstChapter = findFirstNode(nextProject.tree, 'chapter')
      const firstConversation = findFirstNode(nextProject.tree, 'conversation')
      if (firstChapter) {
        await openNode(firstChapter)
      }
      if (firstConversation) {
        await openNode(firstConversation)
      }
    } catch (caught) {
      handleError(caught)
    } finally {
      setBusy(null)
    }
  }

  async function refreshTree(rootPath = project?.rootPath) {
    if (!bridgeAvailable || !rootPath) {
      return
    }
    const nextTree = await window.ghostwrite.listProjectTree(rootPath)
    startTransition(() => {
      setTree(nextTree)
      setProject((current) =>
        current ? { ...current, tree: nextTree } : { name: nextTree.name, rootPath, tree: nextTree },
      )
    })
  }

  async function openNode(node: TreeNode) {
    if (!bridgeAvailable) {
      return
    }
    try {
      setSelectedNode({ path: node.path, kind: node.kind })
      if (node.kind === 'chapter') {
        const document = await window.ghostwrite.readChapter(node.path)
        setActiveDocument({ kind: 'chapter', path: node.path })
        setChapterContent(document.content)
        setSavedChapterContent(document.content)
        setLastAppendedAssistantDraft(null)
        setStatus(`Editing chapter ${node.name}`)
        return
      }

      if (node.kind === 'wikiEntry') {
        const document = await window.ghostwrite.readWikiEntry(node.path)
        setActiveDocument({ kind: 'wiki', path: node.path })
        setWikiDocument(document)
        setWikiDraft(document)
        setStatus(`Inspecting canon entry ${document.name}`)
        return
      }

      if (node.kind === 'conversation') {
        const conversation = await window.ghostwrite.readConversation(node.path)
        setActiveConversation(conversation)
        setStatus(`Conversation open: ${conversation.meta.title}`)
      }
    } catch (caught) {
      handleError(caught)
    }
  }

  async function handleSaveChapter() {
    if (!bridgeAvailable || !activeDocument || activeDocument.kind !== 'chapter') {
      return
    }

    try {
      setBusy('save-chapter')
      const result = await window.ghostwrite.writeChapter(activeDocument.path, chapterContent)
      setSavedChapterContent(result.content)
      setPendingPatch(null)
      setStatus(`Saved ${fileLabel(result.path)}`)
    } catch (caught) {
      handleError(caught)
    } finally {
      setBusy(null)
    }
  }

  async function handleSaveWiki() {
    if (!bridgeAvailable || !wikiDraft || !activeDocument || activeDocument.kind !== 'wiki') {
      return
    }

    try {
      setBusy('save-wiki')
      const result = await window.ghostwrite.updateWikiEntry(activeDocument.path, {
        name: wikiDraft.name,
        type: wikiDraft.type,
        description: wikiDraft.description,
      })
      setWikiDocument(result)
      setWikiDraft(result)
      await refreshTree()
      setStatus(`Saved canon entry ${result.name}`)
    } catch (caught) {
      handleError(caught)
    } finally {
      setBusy(null)
    }
  }

  async function handleCreateChapter() {
    if (!bridgeAvailable || !project) {
      return
    }

    try {
      setBusy('create-chapter')
      const title = buildNextChapterTitle(tree)
      const document = await window.ghostwrite.createChapter(project.rootPath, title)
      await refreshTree()
      await openNode({
        id: document.path,
        kind: 'chapter',
        name: fileLabel(document.path),
        path: document.path,
      })
      setStatus(`Created chapter ${title}.`)
    } catch (caught) {
      handleError(caught)
    } finally {
      setBusy(null)
    }
  }

  async function handleCreateWikiEntry() {
    if (!bridgeAvailable || !project) {
      return
    }
    setDialogState({
      kind: 'wiki',
      wikiType: resolveRequestedWikiType(selectedNode, tree) ?? 'character',
      name: '',
      description: '',
    })
  }

  async function handleCreateConversation() {
    if (!bridgeAvailable || !project) {
      return
    }
    setDialogState({
      kind: 'conversation',
      title: 'Scene planning',
    })
  }

  async function handleRenameSelected() {
    if (!bridgeAvailable || !selectedNode) {
      return
    }
    if (selectedNode.kind === 'folder' || selectedNode.kind === 'root' || selectedNode.kind === 'wikiCategory') {
      setStatus('Protected folders stay fixed in v1.')
      return
    }
    setDialogState({
      kind: 'rename',
      targetPath: selectedNode.path,
      targetKind: selectedNode.kind,
      nextName: fileLabel(selectedNode.path).replace(/\.(md|json|jsonl)$/i, ''),
    })
  }

  async function handleDeleteSelected() {
    if (!bridgeAvailable || !selectedNode) {
      return
    }
    if (selectedNode.kind === 'folder' || selectedNode.kind === 'root' || selectedNode.kind === 'wikiCategory') {
      setStatus('Protected folders stay fixed in v1.')
      return
    }
    setDialogState({
      kind: 'delete',
      targetPath: selectedNode.path,
      targetKind: selectedNode.kind,
      label: fileLabel(selectedNode.path),
    })
  }

  async function handleSendChat() {
    if (!bridgeAvailable) {
      setStatus('AI chat needs the Electron desktop shell so it can reach the local project files.')
      return
    }
    if (!project) {
      setStatus('Open a project before chatting with the AI.')
      return
    }
    const instruction = chatInput.trim()
    if (!instruction) {
      return
    }

    let failedAttempt: FailedChatAttempt | null = null

    try {
      setBusy('ai')
      setError(null)
      setChatInput('')

      let conversation = activeConversation
      if (!conversation) {
        conversation = await window.ghostwrite.createConversation(project.rootPath, 'Session')
        setActiveConversation(conversation)
        await refreshTree()
      }

      const userMessage: ConversationMessage = {
        kind: 'message',
        role: 'user',
        timestamp: new Date().toISOString(),
        content: instruction,
      }

      conversation = await window.ghostwrite.appendConversationMessage(conversation.path, userMessage)
      setActiveConversation(conversation)

      const request: ChatRequest = {
        projectRoot: project.rootPath,
        instruction: userMessage.content,
        sourceText: activeDocument?.kind === 'chapter' ? chapterContent : '',
        chapterPath: activeDocument?.kind === 'chapter' ? activeDocument.path : undefined,
        selection,
        conversation,
        thinkingMode,
      }
      failedAttempt = {
        conversationPath: conversation.path,
        request,
      }

      const response = await window.ghostwrite.chatWithAI(request)

      conversation = await appendAssistantReply(conversation.path, response)
      const appliedCanon = await autoApplyCanonChanges(response)
      const nextPatch =
        response.chapterPatch ??
        buildAssistantAppendPatch(
          activeDocument,
          chapterContent,
          response.assistantMessage,
          userMessage.content,
        )
      const appendedToEditor =
        !response.chapterPatch && nextPatch ? applyAssistantDraftToEditor(nextPatch) : false

      setActiveConversation(conversation)
      setPendingPatch(response.chapterPatch)
      setWikiCreates([])
      setWikiUpdates([])
      setConflicts(response.conflicts)
      setReferencedWikiPaths(response.referencedWikiPaths)
      setPendingChapterDraft(
        !response.chapterPatch &&
          !appendedToEditor &&
          activeDocument?.kind !== 'chapter' &&
          looksLikeChapterDraft(response.assistantMessage)
          ? {
              suggestedTitle: createDraftTitle(userMessage.content, conversation.meta.title),
              content: response.assistantMessage,
            }
          : null,
      )
      setLastFailedChat(null)
      setLastSuccessfulChat({
        conversationPath: conversation.path,
        request,
      })
      setStatus(
        appendedToEditor && appliedCanon > 0
          ? `AI response appended to the editor and canon synced (${appliedCanon} changes).`
          : appliedCanon > 0
            ? `AI response ready. Canon synced automatically (${appliedCanon} changes).`
            : appendedToEditor
              ? 'AI response appended to the editor. Save the chapter when you are ready.'
              : response.chapterPatch
                ? 'AI response ready for the editor.'
                : 'AI response ready for review.',
      )
    } catch (caught) {
      if (failedAttempt) {
        setLastFailedChat(failedAttempt)
      }
      handleError(caught)
    } finally {
      setBusy(null)
    }
  }

  async function handleRetryLastChat() {
    if (!lastFailedChat) {
      return
    }

    try {
      setBusy('retry-ai')
      setError(null)
      const latestConversation = await window.ghostwrite.readConversation(
        lastFailedChat.conversationPath,
      )
      const response = await window.ghostwrite.chatWithAI({
        ...lastFailedChat.request,
        conversation: latestConversation,
      })
      const updatedConversation = await appendAssistantReply(
        lastFailedChat.conversationPath,
        response,
      )
      const appliedCanon = await autoApplyCanonChanges(response)
      const nextPatch =
        response.chapterPatch ??
        buildAssistantAppendPatch(
          activeDocument,
          chapterContent,
          response.assistantMessage,
          lastFailedChat.request.instruction,
        )
      const appendedToEditor =
        !response.chapterPatch && nextPatch ? applyAssistantDraftToEditor(nextPatch) : false
      setActiveConversation(updatedConversation)
      setPendingPatch(response.chapterPatch)
      setWikiCreates([])
      setWikiUpdates([])
      setConflicts(response.conflicts)
      setReferencedWikiPaths(response.referencedWikiPaths)
      setPendingChapterDraft(
        !response.chapterPatch &&
          !appendedToEditor &&
          looksLikeChapterDraft(response.assistantMessage)
          ? {
              suggestedTitle: lastFailedChat.request.chapterPath
                ? fileLabel(lastFailedChat.request.chapterPath).replace(/\.md$/i, '')
                : createDraftTitle(lastFailedChat.request.instruction, latestConversation.meta.title),
              content: response.assistantMessage,
            }
          : null,
      )
      setLastFailedChat(null)
      setLastSuccessfulChat({
        conversationPath: lastFailedChat.conversationPath,
        request: lastFailedChat.request,
      })
      setStatus(
        appendedToEditor && appliedCanon > 0
          ? `Retry succeeded. The new response was appended and canon synced (${appliedCanon} changes).`
          : appliedCanon > 0
            ? `Retry succeeded. Canon synced automatically (${appliedCanon} changes).`
            : appendedToEditor
              ? 'Retry succeeded. The new response was appended to the editor.'
              : response.chapterPatch
                ? 'Retry succeeded. New editor output is ready.'
                : 'Retry succeeded.',
      )
    } catch (caught) {
      handleError(caught)
    } finally {
      setBusy(null)
    }
  }

  async function handleRegenerateResponse() {
    if (!lastSuccessfulChat || !bridgeAvailable) {
      return
    }

    try {
      setBusy('regenerate-ai')
      setError(null)
      if (
        lastAppendedAssistantDraft &&
        activeDocument?.kind === 'chapter' &&
        chapterContent === lastAppendedAssistantDraft.nextContent
      ) {
        setChapterContent(lastAppendedAssistantDraft.originalText)
        setLastAppendedAssistantDraft(null)
      }
      const baseConversation = await window.ghostwrite.removeLastAssistantMessage(
        lastSuccessfulChat.conversationPath,
      )
      const response = await window.ghostwrite.chatWithAI({
        ...lastSuccessfulChat.request,
        conversation: baseConversation,
      })
      const updatedConversation = await appendAssistantReply(
        lastSuccessfulChat.conversationPath,
        response,
      )
      const appliedCanon = await autoApplyCanonChanges(response)
      const nextPatch =
        response.chapterPatch ??
        buildAssistantAppendPatch(
          activeDocument,
          chapterContent,
          response.assistantMessage,
          lastSuccessfulChat.request.instruction,
        )
      const appendedToEditor =
        !response.chapterPatch && nextPatch ? applyAssistantDraftToEditor(nextPatch) : false
      setActiveConversation(updatedConversation)
      setPendingPatch(response.chapterPatch)
      setWikiCreates([])
      setWikiUpdates([])
      setConflicts(response.conflicts)
      setReferencedWikiPaths(response.referencedWikiPaths)
      setPendingChapterDraft(
        !response.chapterPatch &&
          !appendedToEditor &&
          looksLikeChapterDraft(response.assistantMessage)
          ? {
              suggestedTitle: lastSuccessfulChat.request.chapterPath
                ? fileLabel(lastSuccessfulChat.request.chapterPath).replace(/\.md$/i, '')
                : createDraftTitle(
                    lastSuccessfulChat.request.instruction,
                    updatedConversation.meta.title,
                  ),
              content: response.assistantMessage,
            }
          : null,
      )
      setStatus(
        appendedToEditor && appliedCanon > 0
          ? `Response regenerated. The replacement prose was appended and canon synced (${appliedCanon} changes).`
          : appliedCanon > 0
            ? `Response regenerated. Canon synced automatically (${appliedCanon} changes).`
            : appendedToEditor
              ? 'Response regenerated. The replacement prose was appended to the editor.'
              : response.chapterPatch
                ? 'Response regenerated. New editor output is ready.'
                : 'Response regenerated.',
      )
    } catch (caught) {
      handleError(caught)
    } finally {
      setBusy(null)
    }
  }

  async function handleApplyPatch() {
    if (!bridgeAvailable || !pendingPatch || !activeDocument || activeDocument.kind !== 'chapter') {
      return
    }

    try {
      setBusy('apply-patch')
      const document = await window.ghostwrite.writeChapterPatch(
        activeDocument.path,
        pendingPatch.nextContent,
      )
      setChapterContent(document.content)
      setSavedChapterContent(document.content)
      setPendingPatch(null)
      setLastAppendedAssistantDraft(null)
      setStatus('Patch applied to chapter.')
    } catch (caught) {
      handleError(caught)
    } finally {
      setBusy(null)
    }
  }

  async function handleCreateChapterFromDraft() {
    if (!project || !pendingChapterDraft) {
      return
    }

    const chapterTitle = pendingChapterDraft.suggestedTitle.trim() || 'Scene Draft'

    try {
      setBusy('create-draft-chapter')
      const document = await window.ghostwrite.createChapter(project.rootPath, chapterTitle)
      const written = await window.ghostwrite.writeChapter(document.path, pendingChapterDraft.content)
      await refreshTree()
      await openNode({
        id: written.path,
        kind: 'chapter',
        name: fileLabel(written.path),
        path: written.path,
      })
      setPendingChapterDraft(null)
      setStatus(`Created chapter ${chapterTitle}.`)
    } catch (caught) {
      handleError(caught)
    } finally {
      setBusy(null)
    }
  }

  async function handleApproveProposal(proposal: WikiChangeProposal) {
    if (!bridgeAvailable || !project) {
      return
    }

    try {
      setBusy('wiki-proposal')
      if (proposal.action === 'create') {
        await window.ghostwrite.createWikiEntry(
          project.rootPath,
          proposal.entry.type,
          proposal.entry.name,
          proposal.entry.description,
        )
      } else {
        await window.ghostwrite.updateWikiEntry(proposal.path, proposal.entry)
      }

      setWikiCreates((current) => current.filter((entry) => entry.path !== proposal.path))
      setWikiUpdates((current) => current.filter((entry) => entry.path !== proposal.path))
      await refreshTree()
      if (activeDocument?.kind === 'wiki' && activeDocument.path === proposal.path) {
        const refreshed = await window.ghostwrite.readWikiEntry(proposal.path)
        setWikiDocument(refreshed)
        setWikiDraft(refreshed)
      }
      setStatus(`Canon proposal approved for ${proposal.entry.name}.`)
    } catch (caught) {
      handleError(caught)
    } finally {
      setBusy(null)
    }
  }

  async function autoApplyCanonChanges(response: ChatResponse) {
    if (!bridgeAvailable || !project) {
      return 0
    }

    const proposals = [...response.wikiCreates, ...response.wikiUpdates]
    if (proposals.length === 0) {
      return 0
    }

    let applied = 0

    for (const proposal of proposals) {
      if (proposal.action === 'create') {
        await window.ghostwrite.createWikiEntry(
          project.rootPath,
          proposal.entry.type,
          proposal.entry.name,
          proposal.entry.description,
        )
      } else {
        await window.ghostwrite.updateWikiEntry(proposal.path, proposal.entry)
      }
      applied += 1
    }

    await refreshTree()

    if (activeDocument?.kind === 'wiki') {
      const refreshed = await window.ghostwrite.readWikiEntry(activeDocument.path)
      setWikiDocument(refreshed)
      setWikiDraft(refreshed)
    }

    return applied
  }

  async function handleSaveSettings() {
    if (!bridgeAvailable) {
      setStatus('Settings are only available in the Electron desktop app.')
      return
    }
    try {
      setBusy('settings')
      const nextSettings = await window.ghostwrite.saveSettings(settings)
      setSettings(nextSettings)
      setShowSettings(false)
      setStatus('AI settings saved.')
    } catch (caught) {
      handleError(caught)
    } finally {
      setBusy(null)
    }
  }

  async function handleScanChapterToWiki() {
    if (
      !bridgeAvailable ||
      !project ||
      !activeDocument ||
      activeDocument.kind !== 'chapter' ||
      !chapterContent.trim()
    ) {
      return
    }

    try {
      setBusy('scan-canon')
      setError(null)
      const canonResult = await window.ghostwrite.generateCanonSync({
        projectRoot: project.rootPath,
        storyText: chapterContent,
        instruction: `Scan chapter ${fileLabel(activeDocument.path)} and update the story wiki to match any new or changed canon.`,
        thinkingMode,
      })
      const appliedCanon = await autoApplyCanonChanges({
        assistantMessage: '',
        chapterPatch: null,
        wikiCreates: canonResult.wikiCreates,
        wikiUpdates: canonResult.wikiUpdates,
        conflicts: canonResult.conflicts,
        referencedWikiPaths: [],
      })
      setWikiCreates([])
      setWikiUpdates([])
      setConflicts(canonResult.conflicts)
      setStatus(
        appliedCanon > 0
          ? `Wiki updated from ${fileLabel(activeDocument.path)} (${appliedCanon} changes).`
          : canonResult.conflicts.length > 0
            ? `Chapter scan finished with ${canonResult.conflicts.length} canon conflicts.`
            : `No wiki changes were needed for ${fileLabel(activeDocument.path)}.`,
      )
    } catch (caught) {
      handleError(caught)
    } finally {
      setBusy(null)
    }
  }

  async function handleSubmitDialog() {
    if (!bridgeAvailable || !project || !dialogState) {
      return
    }

    try {
      if (dialogState.kind === 'wiki') {
        const name = dialogState.name.trim()
        if (!name) {
          setStatus('A wiki entry needs a name.')
          return
        }

        setBusy('dialog')
        const document = await window.ghostwrite.createWikiEntry(
          project.rootPath,
          dialogState.wikiType,
          name,
          dialogState.description.trim(),
        )
        setDialogState(null)
        await refreshTree()
        await openNode({
          id: document.path,
          kind: 'wikiEntry',
          name: document.name,
          path: document.path,
          wikiType: document.type,
        })
        setStatus(`Created canon entry ${document.name}.`)
        return
      }

      if (dialogState.kind === 'conversation') {
        const title = dialogState.title.trim() || 'Scene planning'
        setBusy('dialog')
        const conversation = await window.ghostwrite.createConversation(project.rootPath, title)
        setDialogState(null)
        setActiveConversation(conversation)
        setSelectedNode({ path: conversation.path, kind: 'conversation' })
        await refreshTree()
        setStatus(`Conversation created: ${conversation.meta.title}`)
        return
      }

      if (dialogState.kind === 'rename') {
        const nextName = dialogState.nextName.trim()
        if (!nextName) {
          setStatus('A new name is required.')
          return
        }

        setBusy('dialog')
        const nextPath = await window.ghostwrite.renameNode(
          dialogState.targetPath,
          dialogState.targetKind,
          nextName,
        )
        setDialogState(null)
        setSelectedNode({ path: nextPath, kind: dialogState.targetKind })
        if (activeDocument?.path === dialogState.targetPath) {
          setActiveDocument({ ...activeDocument, path: nextPath })
        }
        if (activeConversation?.path === dialogState.targetPath) {
          const nextConversation = await window.ghostwrite.readConversation(nextPath)
          setActiveConversation(nextConversation)
        }
        await refreshTree()
        setStatus(`Renamed to ${fileLabel(nextPath)}`)
        return
      }

      if (dialogState.kind === 'selection-ai') {
        if (!activeDocument || activeDocument.kind !== 'chapter') {
          setStatus('Open a chapter before asking the AI to edit selected text.')
          return
        }

        const instruction = dialogState.instruction.trim()
        if (!instruction) {
          setStatus('Tell GhostWrite what you want changed in the selected text.')
          return
        }

        setBusy('selection-ai')
        setError(null)
        const response = await window.ghostwrite.generateChapterPatch({
          projectRoot: project.rootPath,
          instruction: [
            'Edit only the selected passage.',
            'Make the exact change the user asked for.',
            'Return a selection patch if possible.',
            `User request: ${instruction}`,
          ].join(' '),
          sourceText: chapterContent,
          chapterPath: activeDocument.path,
          selection: dialogState.selection,
          conversation: activeConversation,
          thinkingMode,
        })

        const nextPatch =
          response.chapterPatch ??
          buildSelectionPatchFromAssistant(
            chapterContent,
            dialogState.selection,
            response.assistantMessage,
            instruction,
          )

        setDialogState(null)
        setPendingPatch(null)
        setReferencedWikiPaths(response.referencedWikiPaths)
        setConflicts(response.conflicts)
        if (!nextPatch) {
          setStatus('The AI did not return an edit patch for that selection. Try a more specific instruction.')
          return
        }
        setChapterContent(nextPatch.nextContent)
        setSelection(null)
        setLastAppendedAssistantDraft(nextPatch)
        setStatus('Selected text updated in the editor. Save the chapter when you are ready.')
        return
      }

      setBusy('dialog')
      await window.ghostwrite.deleteNode(dialogState.targetPath)
      if (activeDocument?.path === dialogState.targetPath) {
        setActiveDocument(null)
      }
      if (activeConversation?.path === dialogState.targetPath) {
        setActiveConversation(null)
      }
      setDialogState(null)
      setSelectedNode(null)
      await refreshTree()
      setStatus('Selection deleted.')
    } catch (caught) {
      handleError(caught)
    } finally {
      setBusy(null)
    }
  }

  function updateSelectionFromEditor() {
    const editor = editorRef.current
    if (!editor) {
      return
    }

    const { selectionStart, selectionEnd, value } = editor
    if (selectionStart === selectionEnd) {
      setSelection(null)
      return
    }

    setSelection({
      start: selectionStart,
      end: selectionEnd,
      text: value.slice(selectionStart, selectionEnd),
    })
  }

  function handleTreeToggle(targetPath: string) {
    setCollapsedPaths((current) => ({
      ...current,
      [targetPath]: !current[targetPath],
    }))
  }

  function handleTreeContextMenu(event: ReactMouseEvent, node: TreeNode) {
    event.preventDefault()
    event.stopPropagation()
    const actions = getContextMenuActions(node)
    if (actions.length === 0) {
      setContextMenu(null)
      return
    }
    setSelectedNode({ path: node.path, kind: node.kind })
    setContextMenu({
      kind: 'tree',
      node,
      x: event.clientX,
      y: event.clientY,
    })
  }

  function handleEditorContextMenu(event: ReactMouseEvent<HTMLTextAreaElement>) {
    if (activeDocument?.kind !== 'chapter' || !selection?.text?.trim()) {
      setContextMenu(null)
      return
    }

    event.preventDefault()
    event.stopPropagation()
    setContextMenu({
      kind: 'editor-selection',
      x: event.clientX,
      y: event.clientY,
    })
  }

  function handleContextAction(action: ContextAction) {
    setContextMenu(null)
    if (action === 'new-chapter') {
      void handleCreateChapter()
      return
    }
    if (action === 'new-chat') {
      void handleCreateConversation()
      return
    }
    if (action === 'new-entry') {
      void handleCreateWikiEntry()
      return
    }
    if (action === 'rename') {
      void handleRenameSelected()
      return
    }
    void handleDeleteSelected()
  }

  function handleSelectionContextAction() {
    if (!selection?.text?.trim()) {
      setContextMenu(null)
      setStatus('Select some text first, then right-click it to send that passage to the AI.')
      return
    }

    setContextMenu(null)
    setDialogState({
      kind: 'selection-ai',
      instruction: '',
      selection,
    })
  }

  function applyAssistantDraftToEditor(patch: ChapterPatch) {
    if (activeDocument?.kind !== 'chapter') {
      return false
    }

    if (chapterContent.trimEnd() === patch.nextContent.trimEnd()) {
      return false
    }

    setChapterContent(patch.nextContent)
    setLastAppendedAssistantDraft(patch)
    return true
  }

  function handleAppendAssistantMessage(message: ConversationMessage) {
    const patch = buildAssistantAppendPatch(
      activeDocument,
      chapterContent,
      message.content,
      'Append assistant prose',
    )
    if (!patch) {
      setStatus('This assistant message is not in a prose format that can be appended.')
      return
    }

    const applied = applyAssistantDraftToEditor(patch)
    if (!applied) {
      setStatus('That assistant passage is already in the chapter editor.')
      return
    }

    setStatus('Assistant prose appended to the editor. Save the chapter when you are ready.')
  }

  function handleError(caught: unknown) {
    const message = caught instanceof Error ? caught.message : 'Something went wrong.'
    setError(message)
    setStatus(message)
  }

  async function appendAssistantReply(conversationPath: string, response: ChatResponse) {
    const assistantMessage: ConversationMessage = {
      kind: 'message',
      role: 'assistant',
      timestamp: new Date().toISOString(),
      content: response.assistantMessage,
      chapterPatch: response.chapterPatch,
      wikiCreates: response.wikiCreates,
      wikiUpdates: response.wikiUpdates,
      conflicts: response.conflicts,
    }

    return window.ghostwrite.appendConversationMessage(conversationPath, assistantMessage)
  }

  const pendingWikiChanges = [...wikiCreates, ...wikiUpdates]

  if (!bridgeAvailable) {
    return (
      <div className="browser-shell">
        <section className="browser-launch">
          <p className="eyebrow">GhostWrite Desktop</p>
          <h1>Open this in Electron</h1>
          <p className="launch-copy">
            The browser tab is only the renderer dev server. Local project folders, canon files,
            and AI actions all need the desktop shell.
          </p>
          <div className="launch-steps">
            <div>
              <h2>Use this command</h2>
              <pre>npm run dev</pre>
            </div>
            <div>
              <h2>What to expect</h2>
              <p>A separate GhostWrite desktop window should appear. You can close this browser tab.</p>
            </div>
          </div>
          <div className="launch-note">
            <strong>Status:</strong> {status}
          </div>
        </section>
      </div>
    )
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand-lockup">
          <p className="eyebrow">Editorial AI Studio</p>
          <h1>GhostWrite</h1>
        </div>
        <div className="topbar-meta">
          <div className="project-pill">{project ? project.name : 'No project loaded'}</div>
          <button className="accent" onClick={() => setShowSettings(true)}>
            Settings
          </button>
        </div>
      </header>

      <div className="statusbar">
        <span>{project ? project.rootPath : 'No project open'}</span>
        <span>{status}</span>
      </div>

      {error ? (
        <div className="error-banner error-banner-actions">
          <span>{error}</span>
          {lastFailedChat ? (
            <button onClick={handleRetryLastChat} disabled={busy === 'retry-ai' || busy === 'ai'}>
              Retry AI
            </button>
          ) : null}
        </div>
      ) : null}

      <main className="workspace">
        <aside className="pane pane-tree">
          <div className="pane-header">
            <div>
              <p className="eyebrow">Explorer</p>
              <h2>{project ? project.name : 'Project'}</h2>
              <p className="pane-copy">Right-click files and folders for actions.</p>
            </div>
          </div>

          <div className="tree">
            {tree ? (
              <TreeBranch
                node={tree}
                selectedPath={selectedNode?.path ?? null}
                onOpen={openNode}
                collapsedPaths={collapsedPaths}
                onToggle={handleTreeToggle}
                onContextMenu={handleTreeContextMenu}
              />
            ) : (
              <div className="empty-state">
                <h3>Explorer waits here</h3>
                <p>Open a story project to browse chapters, chat logs, and canon files.</p>
              </div>
            )}
          </div>
        </aside>

        <section className="pane pane-editor">
          <div className="pane-header">
            <div>
              <p className="eyebrow">Writing surface</p>
              <h2>
                {activeDocument?.kind === 'chapter'
                  ? fileLabel(activeDocument.path)
                  : activeDocument?.kind === 'wiki'
                    ? wikiDraft?.name ?? 'Canon entry'
                    : 'Editor'}
              </h2>
            </div>
            <div className="cluster">
              {selection ? <span className="pill">Selection ready</span> : null}
              {chapterDirty ? (
                <button className="accent" onClick={handleSaveChapter}>
                  Save chapter
                </button>
              ) : null}
              {activeDocument?.kind === 'chapter' ? (
                <button
                  onClick={handleScanChapterToWiki}
                  disabled={busy === 'scan-canon' || !chapterContent.trim()}
                >
                  Update wiki
                </button>
              ) : null}
              {wikiDirty ? (
                <button className="accent" onClick={handleSaveWiki}>
                  Save entry
                </button>
              ) : null}
            </div>
          </div>

          {!project ? (
            <div className="editor-launch">
              <p className="eyebrow">Workspace</p>
              <h2>Open a story project</h2>
              <p>
                GhostWrite will scaffold the folder structure, load chapters and canon files, and
                keep each conversation tied to the project.
              </p>
              <button className="accent launch-button" onClick={handleOpenProject} disabled={busy === 'project'}>
                Open project
              </button>
            </div>
          ) : null}

          {activeDocument?.kind === 'chapter' ? (
            <div className="editor-stage">
              <textarea
                ref={editorRef}
                className="chapter-editor"
                value={chapterContent}
                onChange={(event) => setChapterContent(event.target.value)}
                onSelect={updateSelectionFromEditor}
                onKeyUp={updateSelectionFromEditor}
                onMouseUp={updateSelectionFromEditor}
                onContextMenu={handleEditorContextMenu}
                placeholder="Write the chapter here, or select a passage and ask the AI to revise it."
              />
            </div>
          ) : null}

          {activeDocument?.kind === 'wiki' && wikiDraft ? (
            <div className="wiki-form">
              <label>
                Name
                <input
                  value={wikiDraft.name}
                  onChange={(event) =>
                    setWikiDraft((current) =>
                      current ? { ...current, name: event.target.value } : current,
                    )
                  }
                />
              </label>
              <label>
                Type
                <select
                  value={wikiDraft.type}
                  onChange={(event) =>
                    setWikiDraft((current) =>
                      current
                        ? { ...current, type: event.target.value as WikiType }
                        : current,
                    )
                  }
                >
                  <option value="character">character</option>
                  <option value="item">item</option>
                  <option value="location">location</option>
                  <option value="event">event</option>
                </select>
              </label>
              <label className="grow">
                Description
                <textarea
                  value={wikiDraft.description}
                  onChange={(event) =>
                    setWikiDraft((current) =>
                      current ? { ...current, description: event.target.value } : current,
                    )
                  }
                />
              </label>
            </div>
          ) : null}

          {project && !activeDocument ? (
            <div className="empty-state editor-empty">
              <h3>Pick a chapter or canon file</h3>
              <p>The editor becomes the writing surface for chapters and the detail view for canon.</p>
            </div>
          ) : null}
        </section>

        <aside className="pane pane-chat">
          <div className="pane-header">
            <div>
              <p className="eyebrow">AI direction</p>
              <h2>{activeConversation?.meta.title ?? 'Conversation'}</h2>
              <p className="pane-copy">
                {thinkingMode
                  ? 'Thinking mode is on for heavier continuity work.'
                  : 'Thinking mode is off for faster direct replies.'}
              </p>
            </div>
            <div className="cluster">
              <label className="thinking-toggle">
                <input
                  type="checkbox"
                  checked={thinkingMode}
                  onChange={(event) => setThinkingMode(event.target.checked)}
                />
                <span>Thinking</span>
              </label>
              <button onClick={handleCreateConversation} disabled={!project || !bridgeAvailable}>
                New chat
              </button>
            </div>
          </div>

          {pendingPatch || pendingChapterDraft || pendingWikiChanges.length > 0 || conflicts.length > 0 ? (
            <section className="review-zone">
            {pendingPatch ? (
              <div className="review-block">
                <div className="review-header">
                  <div>
                    <p className="eyebrow">Patch review</p>
                    <h3>{pendingPatch.summary}</h3>
                  </div>
                  <div className="cluster">
                    <button onClick={() => setPendingPatch(null)}>Reject</button>
                    <button className="accent" onClick={handleApplyPatch}>
                      Apply patch
                    </button>
                  </div>
                </div>
                <div className="diff-preview">
                  {diffPreview.map((part, index) => (
                    <pre
                      key={`${part.value.slice(0, 12)}-${index}`}
                      className={part.added ? 'diff-added' : part.removed ? 'diff-removed' : 'diff-neutral'}
                    >
                      {part.value}
                    </pre>
                  ))}
                </div>
              </div>
            ) : null}

            {pendingChapterDraft ? (
              <div className="review-block">
                <div className="review-header">
                  <div>
                    <p className="eyebrow">Chapter draft</p>
                    <h3>{pendingChapterDraft.suggestedTitle}</h3>
                  </div>
                  <div className="cluster">
                    <button onClick={() => setPendingChapterDraft(null)}>Dismiss</button>
                    <button className="accent" onClick={handleCreateChapterFromDraft}>
                      Create chapter
                    </button>
                  </div>
                </div>
                <div className="draft-preview">
                  <pre>{pendingChapterDraft.content}</pre>
                </div>
              </div>
            ) : null}

            {pendingWikiChanges.length > 0 ? (
              <div className="review-block">
                <div className="review-header">
                  <div>
                    <p className="eyebrow">Canon proposals</p>
                    <h3>{pendingWikiChanges.length} changes waiting</h3>
                  </div>
                </div>
                <div className="proposal-list">
                  {pendingWikiChanges.map((proposal) => (
                    <article key={`${proposal.action}-${proposal.path}`} className="proposal-item">
                      <div>
                        <p className="proposal-kind">{proposal.action}</p>
                        <h4>{proposal.entry.name}</h4>
                        <p>{proposal.reason}</p>
                        <small>{proposal.sourceEvidence.join(' | ')}</small>
                      </div>
                      <button className="accent" onClick={() => void handleApproveProposal(proposal)}>
                        Approve
                      </button>
                    </article>
                  ))}
                </div>
              </div>
            ) : null}

            {conflicts.length > 0 ? (
              <div className="review-block">
                <div className="review-header">
                  <div>
                    <p className="eyebrow">Canon conflicts</p>
                    <h3>Needs human judgment</h3>
                  </div>
                </div>
                <div className="proposal-list">
                  {conflicts.map((conflict) => (
                    <article key={`${conflict.entityName}-${conflict.message}`} className="proposal-item conflict-item">
                      <div>
                        <h4>{conflict.entityName}</h4>
                        <p>{conflict.message}</p>
                        <small>{conflict.sourceEvidence.join(' | ')}</small>
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            ) : null}
            </section>
          ) : null}

          <section className="chat-log">
            {!project ? (
              <div className="empty-state compact">
                <h3>Project chat lives here</h3>
                <p>Open a story project to plan scenes, direct rewrites, and generate prose.</p>
              </div>
            ) : activeConversation?.messages.length ? (
              activeConversation.messages.map((message, index) => {
                const isLatestAssistant =
                  message.role === 'assistant' &&
                  index === activeConversation.messages.length - 1
                const canAppendToChapter =
                  activeDocument?.kind === 'chapter' &&
                  !message.chapterPatch &&
                  looksAppendableStoryText(message.content)
                const alreadyAppended =
                  canAppendToChapter &&
                  lastAppendedAssistantDraft?.nextContent.trimEnd() === chapterContent.trimEnd() &&
                  lastAppendedAssistantDraft.updatedText.includes(message.content.trim())

                return (
                  <article key={`${message.timestamp}-${index}`} className={`chat-bubble ${message.role}`}>
                    <span>{message.role}</span>
                    <p>{message.content}</p>
                    {isLatestAssistant || canAppendToChapter ? (
                      <div className="chat-bubble-actions">
                        {canAppendToChapter ? (
                          <button
                            onClick={() => handleAppendAssistantMessage(message)}
                            disabled={alreadyAppended}
                          >
                            {alreadyAppended ? 'Appended' : 'Append to chapter'}
                          </button>
                        ) : null}
                        {isLatestAssistant ? (
                          <button
                            onClick={handleRegenerateResponse}
                            disabled={!lastSuccessfulChat || busy === 'ai' || busy === 'retry-ai' || busy === 'regenerate-ai'}
                          >
                            Regenerate
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </article>
                )
              })
            ) : (
              <div className="empty-state compact">
                <h3>Direct the story</h3>
                <p>Use chat to plan scenes, rewrite passages, or ask for canon-aware story moves.</p>
              </div>
            )}
          </section>

          <div className="chat-composer">
            {referencedWikiPaths.length ? (
              <p className="reference-strip">
                Referencing {referencedWikiPaths.map(fileLabel).join(', ')}
              </p>
            ) : null}
            <textarea
              value={chatInput}
              onChange={(event) => setChatInput(event.target.value)}
              placeholder="Ask GhostWrite to plan, continue, rewrite, or fix continuity."
            />
            <div className="composer-actions">
              <span>
                {busy === 'ai'
                  ? 'Thinking with canon...'
                  : busy === 'regenerate-ai'
                    ? 'Regenerating the last assistant reply...'
                  : lastFailedChat
                    ? 'The last AI request failed. Retry it without sending a duplicate message.'
                    : 'AI will save the conversation to this project.'}
              </span>
              <button
                onClick={handleRetryLastChat}
                disabled={!lastFailedChat || busy === 'retry-ai' || busy === 'ai' || busy === 'regenerate-ai'}
              >
                Retry AI
              </button>
              <button
                className="accent"
                onClick={handleSendChat}
                disabled={
                  busy === 'ai' ||
                  busy === 'retry-ai' ||
                  busy === 'regenerate-ai' ||
                  !project ||
                  !bridgeAvailable
                }
              >
                Send
              </button>
            </div>
          </div>
        </aside>
      </main>

      {contextMenu ? (
        <div className="context-menu-layer" onClick={() => setContextMenu(null)}>
          <div
            className="context-menu"
            style={{ top: contextMenu.y, left: contextMenu.x }}
            onClick={(event) => event.stopPropagation()}
          >
            {contextMenu.kind === 'tree' && contextMenu.node
              ? getContextMenuActions(contextMenu.node).map((action) => (
                  <button
                    key={action.key}
                    className="context-menu-item"
                    onClick={() => handleContextAction(action.key)}
                  >
                    {action.label}
                  </button>
                ))
              : null}
            {contextMenu.kind === 'editor-selection' ? (
              <button className="context-menu-item" onClick={handleSelectionContextAction}>
                Ask AI to edit selection
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {showSettings ? (
        <div className="settings-sheet">
          <div className="settings-panel">
            <div className="pane-header">
              <div>
                <p className="eyebrow">Provider settings</p>
                <h2>OpenRouter</h2>
              </div>
              <button onClick={() => setShowSettings(false)}>Close</button>
            </div>
            <label>
              API key
              <input
                type="password"
                value={settings.apiKey}
                onChange={(event) =>
                  setSettings((current) => ({ ...current, apiKey: event.target.value }))
                }
                placeholder="sk-or-v1-..."
              />
            </label>
            <label>
              Model
              <input
                value={settings.model}
                onChange={(event) =>
                  setSettings((current) => ({ ...current, model: event.target.value }))
                }
              />
            </label>
            <label>
              Base URL
              <input
                value={settings.baseUrl}
                onChange={(event) =>
                  setSettings((current) => ({ ...current, baseUrl: event.target.value }))
                }
              />
            </label>
            <label>
              System prompt
              <textarea
                value={settings.systemPrompt}
                onChange={(event) =>
                  setSettings((current) => ({ ...current, systemPrompt: event.target.value }))
                }
                placeholder="Define GhostWrite's core behavior and guardrails."
              />
            </label>
            <button className="accent full" onClick={handleSaveSettings}>
              Save settings
            </button>
          </div>
        </div>
      ) : null}

      {dialogState ? (
        <div className="settings-sheet">
          <div className="settings-panel action-panel">
            <div className="pane-header">
              <div>
                <p className="eyebrow">
                  {dialogState.kind === 'wiki'
                    ? 'New canon entry'
                    : dialogState.kind === 'conversation'
                      ? 'New conversation'
                      : dialogState.kind === 'rename'
                        ? 'Rename selection'
                        : dialogState.kind === 'selection-ai'
                          ? 'AI edit request'
                        : 'Delete selection'}
                </p>
                <h2>
                  {dialogState.kind === 'wiki'
                    ? 'Create wiki entry'
                    : dialogState.kind === 'conversation'
                      ? 'Create chat'
                      : dialogState.kind === 'rename'
                        ? 'Rename file'
                        : dialogState.kind === 'selection-ai'
                          ? 'Change selected text'
                        : 'Confirm delete'}
                </h2>
              </div>
              <button onClick={() => setDialogState(null)}>Cancel</button>
            </div>

            {dialogState.kind === 'wiki' ? (
              <div className="dialog-form">
                <label>
                  Type
                  <select
                    value={dialogState.wikiType}
                    onChange={(event) =>
                      setDialogState((current) =>
                        current?.kind === 'wiki'
                          ? { ...current, wikiType: event.target.value as WikiType }
                          : current,
                      )
                    }
                  >
                    <option value="character">character</option>
                    <option value="item">item</option>
                    <option value="location">location</option>
                    <option value="event">event</option>
                  </select>
                </label>
                <label>
                  Name
                  <input
                    value={dialogState.name}
                    onChange={(event) =>
                      setDialogState((current) =>
                        current?.kind === 'wiki'
                          ? { ...current, name: event.target.value }
                          : current,
                      )
                    }
                    placeholder="Ron Brightshield"
                  />
                </label>
                <label>
                  Starting description
                  <textarea
                    value={dialogState.description}
                    onChange={(event) =>
                      setDialogState((current) =>
                        current?.kind === 'wiki'
                          ? { ...current, description: event.target.value }
                          : current,
                      )
                    }
                    placeholder="Add a starting canon note, or leave this blank and let GhostWrite propose updates later."
                  />
                </label>
              </div>
            ) : null}

            {dialogState.kind === 'conversation' ? (
              <div className="dialog-form">
                <label>
                  Conversation title
                  <input
                    value={dialogState.title}
                    onChange={(event) =>
                      setDialogState((current) =>
                        current?.kind === 'conversation'
                          ? { ...current, title: event.target.value }
                          : current,
                      )
                    }
                    placeholder="Scene planning"
                  />
                </label>
              </div>
            ) : null}

            {dialogState.kind === 'rename' ? (
              <div className="dialog-form">
                <label>
                  New name
                  <input
                    value={dialogState.nextName}
                    onChange={(event) =>
                      setDialogState((current) =>
                        current?.kind === 'rename'
                          ? { ...current, nextName: event.target.value }
                          : current,
                      )
                    }
                  />
                </label>
              </div>
            ) : null}

            {dialogState.kind === 'selection-ai' ? (
              <div className="dialog-form">
                <label>
                  Selected text
                  <textarea value={dialogState.selection.text} readOnly className="dialog-preview" />
                </label>
                <label>
                  What should the AI change?
                  <textarea
                    value={dialogState.instruction}
                    onChange={(event) =>
                      setDialogState((current) =>
                        current?.kind === 'selection-ai'
                          ? { ...current, instruction: event.target.value }
                          : current,
                      )
                    }
                    placeholder="Example: tighten the dialogue, make Edward more suspicious, and keep the same factual meaning."
                  />
                </label>
              </div>
            ) : null}

            {dialogState.kind === 'delete' ? (
              <div className="dialog-copy danger-copy">
                <p>Delete <strong>{dialogState.label}</strong> from this project?</p>
                <p>This removes the file from disk.</p>
              </div>
            ) : null}

            <div className="dialog-actions">
              <button onClick={() => setDialogState(null)}>Cancel</button>
              <button
                className="accent"
                onClick={handleSubmitDialog}
                disabled={busy === 'dialog'}
              >
                {dialogState.kind === 'delete'
                  ? 'Delete'
                  : dialogState.kind === 'rename'
                    ? 'Rename'
                    : dialogState.kind === 'selection-ai'
                      ? 'Generate edit'
                    : dialogState.kind === 'conversation'
                      ? 'Create chat'
                      : 'Create entry'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function TreeBranch({
  node,
  selectedPath,
  onOpen,
  collapsedPaths,
  onToggle,
  onContextMenu,
  depth = 0,
}: {
  node: TreeNode
  selectedPath: string | null
  onOpen: (node: TreeNode) => void | Promise<void>
  collapsedPaths: Record<string, boolean>
  onToggle: (targetPath: string) => void
  onContextMenu: (event: ReactMouseEvent, node: TreeNode) => void
  depth?: number
}) {
  const collapsed = collapsedPaths[node.path] ?? false
  const isContainer = isTreeContainerNode(node)

  return (
    <div>
      {node.kind !== 'root' ? (
        <button
          className={`tree-node ${selectedPath === node.path ? 'selected' : ''} ${isContainer ? 'group' : ''}`}
          style={{ paddingLeft: `${depth * 18 + 12}px` }}
          onClick={() => {
            if (isContainer) {
              void onOpen(node)
              onToggle(node.path)
              return
            }
            void onOpen(node)
          }}
          onContextMenu={(event) => onContextMenu(event, node)}
        >
          <span className="tree-node-main">
            <span className={`tree-chevron ${!isContainer ? 'placeholder' : ''}`}>
              {isContainer ? (collapsed ? '>' : 'v') : '•'}
            </span>
            <span>{node.name}</span>
          </span>
          <small>{treeNodeMeta(node)}</small>
        </button>
      ) : null}
      {(node.kind === 'root' || !collapsed) &&
        node.children?.map((child) => (
        <TreeBranch
          key={child.id}
          node={child}
          selectedPath={selectedPath}
          onOpen={onOpen}
          collapsedPaths={collapsedPaths}
          onToggle={onToggle}
          onContextMenu={onContextMenu}
          depth={node.kind === 'root' ? depth : depth + 1}
        />
        ))}
    </div>
  )
}

function findFirstNode(node: TreeNode, kind: TreeNodeKind): TreeNode | null {
  if (node.kind === kind) {
    return node
  }

  for (const child of node.children ?? []) {
    const found = findFirstNode(child, kind)
    if (found) {
      return found
    }
  }

  return null
}

function resolveRequestedWikiType(
  selectedNode: { path: string; kind: TreeNodeKind } | null,
  tree: TreeNode | null,
): WikiType | null {
  if (!selectedNode || !tree) {
    return null
  }

  const node = findNodeByPath(tree, selectedNode.path)
  return node?.wikiType ?? null
}

function findNodeByPath(node: TreeNode, targetPath: string): TreeNode | null {
  if (node.path === targetPath) {
    return node
  }

  for (const child of node.children ?? []) {
    const found = findNodeByPath(child, targetPath)
    if (found) {
      return found
    }
  }

  return null
}

function fileLabel(targetPath: string) {
  const normalized = targetPath.replace(/\\/g, '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

function looksLikeChapterDraft(text: string) {
  const trimmed = text.trim()
  if (trimmed.length < 220) {
    return false
  }

  const lines = trimmed.split(/\r?\n/)
  const listLines = lines.filter((line) => /^\s*([-*]|\d+\.)\s+/.test(line)).length
  if (listLines >= 2) {
    return false
  }

  const paragraphs = trimmed.split(/\n\s*\n/).filter((paragraph) => paragraph.trim().length > 80)
  return paragraphs.length >= 2 || /[.!?]["”']?\s+[A-Z]/.test(trimmed)
}

function createDraftTitle(instruction: string, conversationTitle?: string) {
  const cleanedInstruction = instruction
    .replace(/[#*_`"]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (cleanedInstruction) {
    return cleanedInstruction.slice(0, 48).trim()
  }

  if (conversationTitle?.trim()) {
    return `${conversationTitle.trim()} draft`
  }

  return 'Scene Draft'
}

function buildNextChapterTitle(tree: TreeNode | null) {
  const chapterNames = collectNodeNames(tree, 'chapter')
  let number = 1

  while (number < 1000) {
    const candidate = `Chapter ${String(number).padStart(2, '0')}`
    if (!chapterNames.has(candidate.toLowerCase()) && !chapterNames.has(candidate.toLowerCase() + '.md')) {
      return candidate
    }
    number += 1
  }

  return 'Untitled Chapter'
}

function collectNodeNames(tree: TreeNode | null, kind: TreeNodeKind) {
  const names = new Set<string>()
  if (!tree) {
    return names
  }

  const stack = [tree]
  while (stack.length > 0) {
    const node = stack.pop()
    if (!node) {
      continue
    }
    if (node.kind === kind) {
      names.add(node.name.toLowerCase())
    }
    for (const child of node.children ?? []) {
      stack.push(child)
    }
  }
  return names
}

function looksAppendableStoryText(text: string) {
  const trimmed = text.trim()
  if (trimmed.length < 120) {
    return false
  }

  const lines = trimmed.split(/\r?\n/)
  const listLines = lines.filter((line) => /^\s*([-*]|\d+\.)\s+/.test(line)).length
  if (listLines >= 2) {
    return false
  }

  return /[.!?]/.test(trimmed)
}

function buildSelectionPatchFromAssistant(
  sourceText: string,
  selection: TextSelection,
  assistantMessage: string,
  instruction: string,
): ChapterPatch | null {
  const replacement = assistantMessage.trim()
  if (!replacement) {
    return null
  }

  const nextContent =
    sourceText.slice(0, selection.start) + replacement + sourceText.slice(selection.end)

  return {
    target: 'selection',
    summary: instruction.trim()
      ? `Edit selection: ${instruction.trim().slice(0, 48)}`
      : 'Edit selected text',
    originalText: selection.text,
    updatedText: replacement,
    nextContent,
  }
}

function buildAssistantAppendPatch(
  activeDocument: ActiveDocument,
  sourceText: string,
  assistantMessage: string,
  instruction: string,
): ChapterPatch | null {
  if (activeDocument?.kind !== 'chapter' || !looksAppendableStoryText(assistantMessage)) {
    return null
  }

  const trimmedSource = sourceText.trimEnd()
  const nextContent = `${trimmedSource}${trimmedSource ? '\n\n' : ''}${assistantMessage.trim()}\n`

  return {
    target: 'chapter',
    summary: instruction.trim()
      ? `Append AI response: ${instruction.trim().slice(0, 48)}`
      : 'Append AI response',
    originalText: sourceText,
    updatedText: nextContent,
    nextContent,
  }
}

function getContextMenuActions(node: TreeNode): Array<{ key: ContextAction; label: string }> {
  if (node.kind === 'folder' && node.name === 'Chapters') {
    return [{ key: 'new-chapter', label: 'New chapter' }]
  }
  if (node.kind === 'folder' && node.name === 'Conversations') {
    return [{ key: 'new-chat', label: 'New chat' }]
  }
  if (node.kind === 'wikiCategory') {
    return [{ key: 'new-entry', label: `New ${node.wikiType ?? 'wiki'} entry` }]
  }
  if (node.kind === 'chapter') {
    return [
      { key: 'new-chapter', label: 'New chapter' },
      { key: 'rename', label: 'Rename' },
      { key: 'delete', label: 'Delete' },
    ]
  }
  if (node.kind === 'wikiEntry' || node.kind === 'conversation') {
    return [
      { key: 'rename', label: 'Rename' },
      { key: 'delete', label: 'Delete' },
    ]
  }
  return []
}

function isTreeContainerNode(node: TreeNode) {
  return node.kind === 'folder' || node.kind === 'wikiCategory'
}

function treeNodeMeta(node: TreeNode) {
  if (node.kind === 'folder') {
    return 'folder'
  }
  if (node.kind === 'wikiCategory') {
    return 'wiki'
  }
  if (node.kind === 'wikiEntry') {
    return node.wikiType ?? 'entry'
  }
  return node.kind
}

export default App
