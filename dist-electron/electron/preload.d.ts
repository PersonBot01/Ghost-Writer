import type { GhostwriteAPI } from '../src/shared/types.js';
declare global {
    interface Window {
        ghostwrite: GhostwriteAPI;
    }
}
