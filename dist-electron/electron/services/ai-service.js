import path from 'node:path';
import { WIKI_TYPES, } from '../../src/shared/types.js';
import { listWikiDocuments, resolveWikiPath } from './project-service.js';
const OPENROUTER_TIMEOUT_MS = 45_000;
export async function chatWithAI(request, settings) {
    if (!request.sourceText.trim() && !request.chapterPath && !request.selection?.text?.trim()) {
        return generatePlanningResponse(request, settings);
    }
    const patchResult = await generateChapterPatch(request, settings);
    const storyText = patchResult.chapterPatch?.nextContent ?? request.sourceText;
    const canonResult = await generateCanonSync({
        projectRoot: request.projectRoot,
        storyText,
        instruction: request.instruction,
        referencedWikiPaths: patchResult.referencedWikiPaths,
        thinkingMode: request.thinkingMode,
    }, settings);
    return {
        assistantMessage: patchResult.assistantMessage,
        chapterPatch: patchResult.chapterPatch,
        wikiCreates: canonResult.wikiCreates,
        wikiUpdates: canonResult.wikiUpdates,
        conflicts: canonResult.conflicts,
        referencedWikiPaths: patchResult.referencedWikiPaths,
    };
}
export async function generateChapterPatch(request, settings) {
    const wikiDocs = await listWikiDocuments(request.projectRoot);
    const relevantDocs = selectRelevantWikiEntries(wikiDocs, request.instruction, request.sourceText);
    const recentConversation = summarizeConversation(request.conversation);
    const selectionText = request.selection?.text?.trim() ? request.selection.text : '';
    const systemPrompt = [
        settings.systemPrompt.trim(),
        request.thinkingMode
            ? 'Think carefully about continuity, scene logic, and canon before answering, but only return the final answer.'
            : 'Respond directly and keep internal planning light.',
        'Write with continuity discipline.',
        'Treat the supplied wiki entries as authoritative canon.',
        'If canon does not support a detail, avoid asserting it as fact.',
        'Only propose a chapter patch when the user clearly wants the prose changed.',
        'Return valid JSON only.',
    ]
        .filter(Boolean)
        .join(' ');
    const userPrompt = [
        `Instruction:\n${request.instruction}`,
        `Working target: ${selectionText ? 'selection' : 'full chapter'}`,
        `Active chapter path: ${request.chapterPath ?? 'none selected'}`,
        `Current chapter text:\n${request.sourceText || '[empty chapter]'}`,
        selectionText ? `Selected text:\n${selectionText}` : 'Selected text:\n[none]',
        recentConversation ? `Recent conversation:\n${recentConversation}` : 'Recent conversation:\n[none]',
        relevantDocs.length
            ? `Authoritative wiki context:\n${serializeWikiDocs(relevantDocs)}`
            : 'Authoritative wiki context:\n[none found]',
        [
            'Respond with JSON in this shape:',
            '{',
            '  "assistantMessage": "string",',
            '  "patch": null | {',
            '    "target": "selection" | "chapter",',
            '    "summary": "short summary",',
            '    "updatedText": "replacement text for the target"',
            '  }',
            '}',
        ].join('\n'),
    ].join('\n\n');
    const raw = await callOpenRouter(settings, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
    ], 0.4, request.thinkingMode);
    const parsed = parseStructuredJson(raw);
    const patch = buildChapterPatch(request.sourceText, request.selection, parsed.patch ?? null);
    const assistantMessage = extractAssistantMessage(parsed);
    if (!assistantMessage && !patch) {
        throw new Error('The AI returned no usable chapter response. You can retry the request.');
    }
    return {
        assistantMessage: assistantMessage ||
            'I prepared an edit proposal, but the model did not include a separate explanation.',
        chapterPatch: patch && parsed.patch?.summary ? { ...patch, summary: parsed.patch.summary } : patch,
        wikiCreates: [],
        wikiUpdates: [],
        conflicts: [],
        referencedWikiPaths: relevantDocs.map((entry) => entry.path),
    };
}
export async function generateCanonSync(request, settings) {
    if (!request.storyText.trim()) {
        return {
            wikiCreates: [],
            wikiUpdates: [],
            conflicts: [],
        };
    }
    const wikiDocs = await listWikiDocuments(request.projectRoot);
    const relevantDocs = request.referencedWikiPaths?.length
        ? wikiDocs.filter((entry) => request.referencedWikiPaths?.includes(entry.path))
        : selectRelevantWikiEntries(wikiDocs, request.instruction, request.storyText);
    const systemPrompt = [
        settings.systemPrompt.trim(),
        'You are handling canon sync for GhostWrite.',
        'Analyze prose updates and maintain a living story wiki.',
        'Do not invent unsupported facts.',
        'If the prose conflicts with canon, report a conflict instead of silently overwriting it.',
        'Return valid JSON only.',
    ]
        .filter(Boolean)
        .join(' ');
    const userPrompt = [
        `Instruction:\n${request.instruction}`,
        `Story text to analyze:\n${request.storyText || '[empty]'}`,
        relevantDocs.length
            ? `Existing wiki context:\n${serializeWikiDocs(relevantDocs)}`
            : 'Existing wiki context:\n[none found]',
        [
            'Respond with JSON in this shape:',
            '{',
            '  "creates": [{ "name": "string", "type": "character|item|location|event", "description": "string", "reason": "string", "sourceEvidence": ["string"] }],',
            '  "updates": [{ "name": "string", "type": "character|item|location|event", "description": "string", "reason": "string", "sourceEvidence": ["string"] }],',
            '  "conflicts": [{ "entityName": "string", "message": "string", "sourceEvidence": ["string"] }]',
            '}',
        ].join('\n'),
    ].join('\n\n');
    const raw = await callOpenRouter(settings, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
    ], 0.2, request.thinkingMode);
    const parsed = parseStructuredJson(raw);
    const byName = new Map(wikiDocs.map((entry) => [entry.name.toLowerCase(), entry]));
    const wikiCreates = buildProposals(parsed.creates ?? [], request.projectRoot, byName, 'create');
    const wikiUpdates = buildProposals(parsed.updates ?? [], request.projectRoot, byName, 'update');
    const conflicts = (parsed.conflicts ?? [])
        .filter((conflict) => conflict.entityName && conflict.message)
        .map((conflict) => {
        const existing = byName.get(conflict.entityName.toLowerCase());
        return {
            entityName: conflict.entityName,
            message: conflict.message,
            existingPath: existing?.path,
            sourceEvidence: conflict.sourceEvidence ?? [],
        };
    });
    return {
        wikiCreates,
        wikiUpdates,
        conflicts,
    };
}
async function generatePlanningResponse(request, settings) {
    const wikiDocs = await listWikiDocuments(request.projectRoot);
    const relevantDocs = selectRelevantWikiEntries(wikiDocs, request.instruction, request.instruction);
    const recentConversation = summarizeConversation(request.conversation);
    const raw = await callOpenRouter(settings, [
        {
            role: 'system',
            content: [
                settings.systemPrompt.trim(),
                request.thinkingMode
                    ? 'Think carefully about continuity, scene logic, and canon before answering, but only return the final answer.'
                    : 'Respond directly and keep internal planning light.',
                'Help with planning, ideation, scene direction, and continuity guidance.',
                'Treat any supplied wiki entries as authoritative canon.',
                'Return valid JSON only.',
            ]
                .filter(Boolean)
                .join(' '),
        },
        {
            role: 'user',
            content: [
                `Instruction:\n${request.instruction}`,
                recentConversation ? `Recent conversation:\n${recentConversation}` : 'Recent conversation:\n[none]',
                relevantDocs.length
                    ? `Authoritative wiki context:\n${serializeWikiDocs(relevantDocs)}`
                    : 'Authoritative wiki context:\n[none found]',
                'Respond with JSON in this shape:',
                '{ "assistantMessage": "string" }',
            ].join('\n\n'),
        },
    ], 0.5, request.thinkingMode);
    const parsed = parseStructuredJson(raw);
    const assistantMessage = extractAssistantMessage(parsed);
    if (!assistantMessage) {
        throw new Error('The AI returned no usable planning response. You can retry the request.');
    }
    const referencedWikiPaths = relevantDocs.map((entry) => entry.path);
    const canonResult = looksLikeStoryDraft(assistantMessage)
        ? await generateCanonSync({
            projectRoot: request.projectRoot,
            storyText: assistantMessage,
            instruction: request.instruction,
            referencedWikiPaths,
            thinkingMode: request.thinkingMode,
        }, settings)
        : {
            wikiCreates: [],
            wikiUpdates: [],
            conflicts: [],
        };
    return {
        assistantMessage,
        chapterPatch: null,
        wikiCreates: canonResult.wikiCreates,
        wikiUpdates: canonResult.wikiUpdates,
        conflicts: canonResult.conflicts,
        referencedWikiPaths,
    };
}
async function callOpenRouter(settings, messages, temperature, thinkingMode) {
    const apiKey = settings.apiKey || process.env.OPENROUTER_API_KEY || '';
    if (!apiKey) {
        throw new Error('Add an OpenRouter API key in Settings before using AI features.');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OPENROUTER_TIMEOUT_MS);
    let response;
    try {
        const requestBody = {
            model: settings.model,
            messages,
            temperature,
            response_format: { type: 'json_object' },
            reasoning: thinkingMode
                ? { enabled: true, effort: 'medium', exclude: true }
                : { enabled: false, effort: 'none', exclude: true },
        };
        response = await fetch(`${settings.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://ghostwrite.local',
                'X-Title': 'GhostWrite',
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
        });
    }
    catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            throw new Error(`OpenRouter request timed out after ${OPENROUTER_TIMEOUT_MS / 1000} seconds. Try a shorter prompt or a faster model.`);
        }
        throw error;
    }
    finally {
        clearTimeout(timeout);
    }
    if (!response.ok) {
        const detail = await response.text();
        throw new Error(`OpenRouter request failed (${response.status}): ${detail}`);
    }
    const data = (await response.json());
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
        throw new Error('OpenRouter returned no message content.');
    }
    return content;
}
function selectRelevantWikiEntries(entries, instruction, sourceText) {
    const combined = `${instruction}\n${sourceText}`.toLowerCase();
    const exactMatches = entries.filter((entry) => combined.includes(entry.name.toLowerCase()));
    if (exactMatches.length > 0) {
        return exactMatches.slice(0, 12);
    }
    const tokens = new Set(combined
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length > 3));
    return entries
        .map((entry) => {
        const haystack = `${entry.name} ${entry.description}`.toLowerCase();
        let score = 0;
        tokens.forEach((token) => {
            if (haystack.includes(token)) {
                score += 1;
            }
        });
        return { entry, score };
    })
        .filter((candidate) => candidate.score > 0)
        .sort((left, right) => right.score - left.score)
        .slice(0, 12)
        .map((candidate) => candidate.entry);
}
function serializeWikiDocs(entries) {
    return entries
        .map((entry) => {
        const folder = entry.type === 'character'
            ? 'characters'
            : entry.type === 'item'
                ? 'items'
                : entry.type === 'location'
                    ? 'locations'
                    : 'events';
        const relativePath = path.join('wiki', folder, path.basename(entry.path));
        return [
            `Path: ${relativePath}`,
            `Name: ${entry.name}`,
            `Type: ${entry.type}`,
            `Description: ${entry.description}`,
        ].join('\n');
    })
        .join('\n\n---\n\n');
}
function summarizeConversation(session) {
    if (!session) {
        return '';
    }
    return session.messages
        .slice(-8)
        .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
        .join('\n');
}
function parseStructuredJson(raw) {
    try {
        return JSON.parse(raw);
    }
    catch {
        const match = raw.match(/\{[\s\S]*\}/);
        if (!match) {
            throw new Error('The AI response was not valid JSON.');
        }
        return JSON.parse(match[0]);
    }
}
function extractAssistantMessage(payload) {
    if (!payload) {
        return null;
    }
    const candidateKeys = [
        'assistantMessage',
        'assistant_message',
        'message',
        'response',
        'reply',
        'content',
        'text',
        'plan',
        'outline',
    ];
    for (const key of candidateKeys) {
        const value = payload[key];
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }
    for (const value of Object.values(payload)) {
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }
    return null;
}
function looksLikeStoryDraft(text) {
    const trimmed = text.trim();
    if (trimmed.length < 220) {
        return false;
    }
    const lines = trimmed.split(/\r?\n/);
    const listLines = lines.filter((line) => /^\s*([-*]|\d+\.)\s+/.test(line)).length;
    if (listLines >= 2) {
        return false;
    }
    const paragraphs = trimmed.split(/\n\s*\n/).filter((paragraph) => paragraph.trim().length > 80);
    return paragraphs.length >= 2 || /[.!?]["”']?\s+[A-Z]/.test(trimmed);
}
function buildChapterPatch(sourceText, selection, patch) {
    if (!patch?.updatedText?.trim()) {
        return null;
    }
    const target = patch.target === 'selection' && selection?.text?.length ? 'selection' : 'chapter';
    if (target === 'selection' && selection) {
        const nextContent = sourceText.slice(0, selection.start) +
            patch.updatedText +
            sourceText.slice(selection.end);
        return {
            target,
            summary: 'Update selected passage',
            originalText: selection.text,
            updatedText: patch.updatedText,
            nextContent,
        };
    }
    return {
        target: 'chapter',
        summary: 'Rewrite active chapter',
        originalText: sourceText,
        updatedText: patch.updatedText,
        nextContent: patch.updatedText,
    };
}
function buildProposals(items, projectRoot, byName, requestedAction) {
    return items
        .filter((item) => Boolean(item.name && item.description && item.type && WIKI_TYPES.includes(item.type)))
        .map((item) => {
        const existing = byName.get(item.name.toLowerCase());
        const action = requestedAction === 'create' && existing ? 'update' : requestedAction;
        const entry = {
            name: item.name,
            type: item.type,
            description: item.description,
        };
        return {
            action,
            path: existing?.path ?? resolveWikiPath(projectRoot, entry),
            entry,
            reason: item.reason ?? `Refresh ${item.name} to match the latest story draft.`,
            sourceEvidence: item.sourceEvidence ?? [],
        };
    });
}
