import { type CanonSyncRequest, type ChatRequest, type ChatResponse } from '../../src/shared/types.js';
interface StoredSettings {
    apiKey: string;
    model: string;
    baseUrl: string;
    systemPrompt: string;
}
export declare function chatWithAI(request: ChatRequest, settings: StoredSettings): Promise<ChatResponse>;
export declare function generateChapterPatch(request: ChatRequest, settings: StoredSettings): Promise<ChatResponse>;
export declare function generateCanonSync(request: CanonSyncRequest, settings: StoredSettings): Promise<Pick<ChatResponse, 'wikiCreates' | 'wikiUpdates' | 'conflicts'>>;
export {};
