// Central config — single source of truth for ports and host.
//
// Note: REPLICATA.cdpPort is duplicated in package.json's `chrome` script
// (npm scripts can't import TS). Keep them in sync.

export const REPLICATA = {
  host: '127.0.0.1',
  port: 3589,
  cdpPort: 9222,
} as const;