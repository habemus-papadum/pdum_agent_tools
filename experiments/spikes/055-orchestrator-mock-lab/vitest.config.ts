import { defineConfig } from 'vitest/config';
import { mockViteConfig } from './vite.config.ts';
export default defineConfig({ ...mockViteConfig(), test: {
  include: ['shared/*.test.ts', '../053-orchestrator-overview/*.test.ts', '../054-orchestrator-session/src/*.test.ts', '../054-orchestrator-session/src/model/*.test.ts', '../059-historical-viewer/src/*.test.ts', '../059-historical-viewer/src/model/*.test.ts', '../060-authentication-flows/src/*.test.ts', '../060-authentication-flows/src/model/*.test.ts', '../061-ingestion-statistics/src/**/*.test.ts', '../062-launcher-connections/src/**/*.test.ts', '../063-profile-workbench/src/**/*.test.ts', '../067-live-session-workspace/src/**/*.test.ts'],
  exclude: ['**/node_modules/**'], environment: 'jsdom',
} });
