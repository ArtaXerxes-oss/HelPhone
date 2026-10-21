/**
 * Services Index
 * Centralized export for all API services
 */

// Core API service
export { api, default as ApiService } from './api';
export type { ApiError, ApiResponse, ApiRequestOptions, Interceptor } from './api';

// Domain-specific services
export { preferencesService, default as PreferencesService } from './preferences';
export type { UserPreferences, PreferencesResponse } from './preferences';

export { responderStatusService, default as ResponderStatusService } from './responderStatus';
export type { ResponderStatus, UpdateResponderStatusRequest } from './responderStatus';

export { feedbackService, default as FeedbackService } from './feedback';
export type { FeedbackSubmission, FeedbackResponse } from './feedback';

export { zkProverService, default as ZKProverService } from './zkProver';
export type {
  ProofZone,
  LocationProofInputs,
  ZKProofRequest,
  ZKProofResponse,
  HealthCheckResponse,
  BlockchainRPCRequest,
  BlockchainRPCResponse,
} from './zkProver';

/**
 * Initialize all services with custom configuration if needed
 */
export function initializeServices(config?: {
  apiBaseURL?: string;
  zkProverURL?: string;
  defaultTimeout?: number;
}) {
  // Note: Services are already initialized as singletons
  // This function can be used to reconfigure them if needed
  console.log('Services initialized with config:', config);
  
  return {
    api,
    preferencesService,
    responderStatusService,
    feedbackService,
    zkProverService,
  };
}