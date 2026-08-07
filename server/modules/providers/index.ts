export { sessionSynchronizerService } from './services/session-synchronizer.service.js';
export { providerSkillsService } from './services/skills.service.js';
export { providerMcpService } from './services/mcp.service.js';
// Runtime service: the server shares the singleton across Agent and WebSocket;
// Agent transport tests use the factory with an isolated fake typed runtime.
export {
  createProviderRuntimeService,
  providerRuntimeService,
} from './services/provider-runtime.service.js';
export { configureSessionChangePublisher } from './services/session-change-publisher.service.js';
export { configureSessionRunStateReader } from './services/session-run-state-reader.service.js';

// providerModelsService: used by Commands to list models and resolve the active session model.
export { providerModelsService } from './services/provider-models.service.js';

// providerRegistry: the assembly root reads the registered provider ids from
// here to hand them to the database layer, which must not import the registry.
export { providerRegistry } from './provider.registry.js';

export { initializeSessionsWatcher } from './services/sessions-watcher.service.js';
export { closeSessionsWatcher } from './services/sessions-watcher.service.js';
