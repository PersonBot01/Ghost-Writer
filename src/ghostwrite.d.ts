import type { GhostwriteAPI } from './shared/types'

declare global {
  interface Window {
    ghostwrite: GhostwriteAPI
  }
}

export {}
