/**
 * Core API service with standardized error handling and interceptors
 * Centralizes all HTTP requests for consistent error handling and retry logic
 */

export interface ApiError extends Error {
  status?: number;
  code?: string;
  data?: any;
}

export interface ApiResponse<T = any> {
  data: T;
  status: number;
  statusText: string;
  headers: Headers;
}

export interface ApiRequestOptions extends RequestInit {
  timeout?: number;
  retries?: number;
  retryDelay?: number;
  retryCondition?: (response: Response, error: Error | null) => boolean;
}

export interface Interceptor {
  onRequest?: (config: ApiRequestOptions) => ApiRequestOptions | Promise<ApiRequestOptions>;
  onResponse?: <T>(response: ApiResponse<T>) => ApiResponse<T> | Promise<ApiResponse<T>>;
  onError?: (error: ApiError) => ApiError | Promise<ApiError>;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class ApiService {
  private baseURL: string;
  private defaultOptions: ApiRequestOptions;
  private interceptors: Interceptor[] = [];

  constructor(baseURL?: string, defaultOptions: ApiRequestOptions = {}) {
    this.baseURL = baseURL || this.getDefaultBaseURL();
    this.defaultOptions = {
      headers: {
        'Content-Type': 'application/json',
        ...defaultOptions.headers,
      },
      timeout: 30000,
      retries: 0,
      retryDelay: 1000,
      ...defaultOptions,
    };
  }

  private getDefaultBaseURL(): string {
    // Use VITE_SERVER_URL from environment or default to localhost:3001
    return import.meta.env.VITE_SERVER_URL || 'http://localhost:3001';
  }

  /**
   * Add an interceptor to the service
   */
  addInterceptor(interceptor: Interceptor): void {
    this.interceptors.push(interceptor);
  }

  /**
   * Remove an interceptor from the service
   */
  removeInterceptor(interceptor: Interceptor): void {
    const index = this.interceptors.indexOf(interceptor);
    if (index > -1) {
      this.interceptors.splice(index, 1);
    }
  }

  /**
   * Apply request interceptors
   */
  private async applyRequestInterceptors(config: ApiRequestOptions): Promise<ApiRequestOptions> {
    let result = { ...config };
    for (const interceptor of this.interceptors) {
      if (interceptor.onRequest) {
        result = await interceptor.onRequest(result);
      }
    }
    return result;
  }

  /**
   * Apply response interceptors
   */
  private async applyResponseInterceptors<T>(response: ApiResponse<T>): Promise<ApiResponse<T>> {
    let result = response;
    for (const interceptor of this.interceptors) {
      if (interceptor.onResponse) {
        result = await interceptor.onResponse(result);
      }
    }
    return result;
  }

  /**
   * Apply error interceptors
   */
  private async applyErrorInterceptors(error: ApiError): Promise<ApiError> {
    let result = error;
    for (const interceptor of this.interceptors) {
      if (interceptor.onError) {
        result = await interceptor.onError(result);
      }
    }
    return result;
  }

  /**
   * Create a timeout promise for fetch requests
   */
  private createTimeoutPromise(timeout: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Request timed out after ${timeout}ms`));
      }, timeout);
    });
  }

  /**
   * Default retry condition - retry on network errors or 5xx status codes
   */
  private defaultRetryCondition(response: Response | null, error: Error | null): boolean {
    if (error) {
      // Network errors
      return true;
    }
    if (response) {
      // Server errors
      return response.status >= 500 && response.status < 600;
    }
    return false;
  }

  /**
   * Execute a fetch request with retry logic
   */
  private async executeRequest<T>(
    url: string,
    options: ApiRequestOptions,
    retryCount = 0
  ): Promise<ApiResponse<T>> {
    const {
      timeout = 30000,
      retries = 0,
      retryDelay = 1000,
      retryCondition = this.defaultRetryCondition.bind(this),
      ...fetchOptions
    } = options;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const fetchPromise = fetch(url, {
        ...fetchOptions,
        signal: controller.signal,
      });

      const response = await Promise.race([
        fetchPromise,
        this.createTimeoutPromise(timeout),
      ]);

      clearTimeout(timeoutId);

      if (!response.ok) {
        const error: ApiError = new Error(`HTTP ${response.status}: ${response.statusText}`);
        error.status = response.status;
        
        // Try to parse error response body
        try {
          const errorData = await response.json().catch(() => ({}));
          error.data = errorData;
          error.message = errorData.error || errorData.message || error.message;
        } catch {
          // Ignore JSON parsing errors
        }

        // Check if we should retry
        if (retryCount < retries && retryCondition(response, null)) {
          await new Promise(resolve => setTimeout(resolve, retryDelay));
          return this.executeRequest(url, options, retryCount + 1);
        }

        throw error;
      }

      const data = await response.json().catch(() => ({} as T));

      const apiResponse: ApiResponse<T> = {
        data,
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      };

      return apiResponse;
    } catch (error) {
      clearTimeout(timeoutId);
      
      const apiError: ApiError = error instanceof Error 
        ? error 
        : new Error(String(error));

      // Check if we should retry (network error case)
      if (retryCount < retries && retryCondition(null, apiError)) {
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        return this.executeRequest(url, options, retryCount + 1);
      }

      throw apiError;
    }
  }

  /**
   * Make an HTTP request
   */
  async request<T = any>(
    endpoint: string,
    options: ApiRequestOptions = {}
  ): Promise<ApiResponse<T>> {
    const url = endpoint.startsWith('http') 
      ? endpoint 
      : `${this.baseURL}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;

    const mergedOptions = {
      ...this.defaultOptions,
      ...options,
      headers: {
        ...this.defaultOptions.headers,
        ...options.headers,
      },
    };

    try {
      const finalConfig = await this.applyRequestInterceptors(mergedOptions);
      const response = await this.executeRequest<T>(url, finalConfig);
      return await this.applyResponseInterceptors(response);
    } catch (error) {
      const apiError = error instanceof Error 
        ? { ...error, status: (error as ApiError).status } 
        : new Error(String(error));
      
      const processedError = await this.applyErrorInterceptors(apiError as ApiError);
      throw processedError;
    }
  }

  /**
   * HTTP GET request
   */
  get<T = any>(endpoint: string, options: ApiRequestOptions = {}): Promise<ApiResponse<T>> {
    return this.request<T>(endpoint, { ...options, method: 'GET' });
  }

  /**
   * HTTP POST request
   */
  post<T = any>(
    endpoint: string,
    data?: any,
    options: ApiRequestOptions = {}
  ): Promise<ApiResponse<T>> {
    return this.request<T>(endpoint, {
      ...options,
      method: 'POST',
      body: data ? JSON.stringify(data) : undefined,
    });
  }

  /**
   * HTTP PUT request
   */
  put<T = any>(
    endpoint: string,
    data?: any,
    options: ApiRequestOptions = {}
  ): Promise<ApiResponse<T>> {
    return this.request<T>(endpoint, {
      ...options,
      method: 'PUT',
      body: data ? JSON.stringify(data) : undefined,
    });
  }

  /**
   * HTTP DELETE request
   */
  delete<T = any>(endpoint: string, options: ApiRequestOptions = {}): Promise<ApiResponse<T>> {
    return this.request<T>(endpoint, { ...options, method: 'DELETE' });
  }

  /**
   * HTTP PATCH request
   */
  patch<T = any>(
    endpoint: string,
    data?: any,
    options: ApiRequestOptions = {}
  ): Promise<ApiResponse<T>> {
    return this.request<T>(endpoint, {
      ...options,
      method: 'PATCH',
      body: data ? JSON.stringify(data) : undefined,
    });
  }

  /**
   * Inspect the Soroban storage footprint for a contract function via the
   * server-side inspection endpoint (envelope's read-only / read-write storage
   * keys are appended before signing; see docs/soroban-footprints.md #517).
   */
  async fetchFootprint(
    contractId: string,
    functionName: string,
    args: unknown[] = []
  ): Promise<import('../types/index.js').SorobanFootprintInspectResponse> {
    try {
      const response = await this.post<import('../types/index.js').SorobanFootprintInspectResponse>(
        '/api/soroban/footprint/inspect',
        { contractId, functionName, args }
      );
      return response.data;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  }

  // ── Encrypted emergency dispatch relay ───────────────────────────
  //
  // These endpoints relay *sealed* envelopes. Nothing here is secret to the
  // server: it stores and returns ciphertext it cannot open. Errors are
  // returned rather than thrown, matching fetchFootprint, so a relay outage
  // degrades to "read it from the ledger instead" instead of breaking the
  // emergency submission path.

  /** Register this responder's public key so requesters can seal for them. */
  async registerDispatchKey(
    wallet: string,
    publicKey: string
  ): Promise<import('../types/index.js').DispatchStoreResponse> {
    try {
      const response = await this.post<import('../types/index.js').DispatchStoreResponse>(
        '/api/dispatch/keys',
        { wallet, publicKey }
      );
      return response.data;
    } catch (error) {
      return { success: false, error: toMessage(error) };
    }
  }

  /**
   * Public keys a payload may be sealed to. The relay stores public keys only;
   * private keys are never transmitted.
   */
  async getDispatchRecipientKeys(): Promise<import('../types/index.js').DispatchRecipientResponse> {
    try {
      const response = await this.get<import('../types/index.js').DispatchRecipientResponse>(
        '/api/dispatch/keys'
      );
      return response.data;
    } catch (error) {
      return { success: false, error: toMessage(error) };
    }
  }

  /** Hand a sealed envelope to the relay. */
  async storeDispatchEnvelope(
    requestId: string | number,
    envelope: import('../types/index.js').EncryptedEnvelope
  ): Promise<import('../types/index.js').DispatchStoreResponse> {
    try {
      const response = await this.post<import('../types/index.js').DispatchStoreResponse>(
        `/api/dispatch/payload/${encodeURIComponent(String(requestId))}`,
        { envelope }
      );
      return response.data;
    } catch (error) {
      return { success: false, error: toMessage(error) };
    }
  }

  /**
   * Fetch the sealed envelopes for a request. Returns `envelopes: []` on a
   * cache miss, which is normal — the authoritative copy lives on-chain in the
   * request's `encrypted_payload`.
   */
  async fetchDispatchEnvelopes(
    requestId: string | number
  ): Promise<import('../types/index.js').DispatchFetchResponse> {
    try {
      const response = await this.get<import('../types/index.js').DispatchFetchResponse>(
        `/api/dispatch/payload/${encodeURIComponent(String(requestId))}`
      );
      return response.data;
    } catch (error) {
      return { success: false, error: toMessage(error) };
    }
  }
}

// Default interceptors for common use cases

/**
 * Global error interceptor that logs errors to console in development
 */
export const errorLoggingInterceptor: Interceptor = {
  onError: async (error: ApiError) => {
    if (import.meta.env.DEV) {
      console.error('[API Error]', {
        message: error.message,
        status: error.status,
        code: error.code,
        data: error.data,
      });
    }
    return error;
  },
};

/**
 * Authentication interceptor example
 */
export const authInterceptor = (getToken: () => string | null): Interceptor => ({
  onRequest: async (config: ApiRequestOptions) => {
    const token = getToken();
    if (token) {
      return {
        ...config,
        headers: {
          ...config.headers,
          Authorization: `Bearer ${token}`,
        },
      };
    }
    return config;
  },
});

/**
 * Response normalization interceptor
 */
export const responseNormalizationInterceptor: Interceptor = {
  onResponse: async <T>(response: ApiResponse<T>): Promise<ApiResponse<T>> => {
    // You can normalize response data here if needed
    return response;
  },
};

// Create default API service instance
export const api = new ApiService();

// Add default interceptors
api.addInterceptor(errorLoggingInterceptor);
api.addInterceptor(responseNormalizationInterceptor);

export default ApiService;