export interface HFInferenceProviderInfo {
  providerId?: string;
  status?: string;
}

export interface HFModel {
  id: string;
  pipeline_tag?: string;
  downloads?: number;
  likes?: number;
  tags?: string[];
  createdAt?: string;
  inferenceProviderMapping?: Record<string, HFInferenceProviderInfo>;
}

export interface HFWhoAmIOrg {
  name?: string;
  canPay?: boolean;
  isEnterprise?: boolean;
}

export interface HFWhoAmI {
  name?: string;
  type?: string;
  isPro?: boolean;
  canPay?: boolean;
  periodEnd?: string;
  role?: string;
  orgs?: HFWhoAmIOrg[];
  scopes?: string[] | string;
  permissions?: string[] | string;
  auth?: {
    accessToken?: {
      role?: string;
      permissions?: string[] | string;
      scopes?: string[] | string;
    };
  };
  accessToken?: {
    role?: string;
    permissions?: string[] | string;
    scopes?: string[] | string;
  };
}

export interface HFWhoAmIWithHeaders {
  account: HFWhoAmI;
  rateLimit?: string | null;
  rateLimitPolicy?: string | null;
}

export interface HFRouterProviderPricing {
  input?: number;
  output?: number;
}

export interface HFRouterProvider {
  provider: string;
  status?: string;
  context_length?: number;
  pricing?: HFRouterProviderPricing;
  supports_tools?: boolean;
  supports_structured_output?: boolean;
  is_model_author?: boolean;
}

export interface HFRouterModel {
  id: string;
  providers?: HFRouterProvider[];
}

export interface HFListModelsOptions {
  search?: string;
  sort?: 'downloads' | 'likes' | 'createdAt' | 'trendingScore';
  direction?: 1 | -1;
  limit?: number;
  pipelineTag?: string;
  inferenceProvider?: string;
  token?: string;
}

export class HubAPIError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'HubAPIError';
    this.status = status;
  }
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export class HuggingFaceHubClient {
  private readonly hubBaseUrl: string;
  private readonly routerBaseUrl: string;
  private readonly fetchImpl: FetchFn;

  constructor(options: { hubBaseUrl?: string; routerBaseUrl?: string; fetchImpl?: FetchFn } = {}) {
    this.hubBaseUrl = options.hubBaseUrl ?? 'https://huggingface.co';
    this.routerBaseUrl = options.routerBaseUrl ?? 'https://router.huggingface.co';
    this.fetchImpl = options.fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init));
  }

  async listModels(options: HFListModelsOptions = {}): Promise<HFModel[]> {
    const params = new URLSearchParams();
    params.set('pipeline_tag', options.pipelineTag ?? 'text-generation');
    params.set('inference_provider', options.inferenceProvider ?? 'all');
    params.set('direction', String(options.direction ?? -1));
    params.set('limit', String(options.limit ?? 100));
    if (options.sort) params.set('sort', options.sort);
    if (options.search) params.set('search', options.search);

    const url = `${this.hubBaseUrl}/api/models?${params.toString()}`;
    return this.requestJson<HFModel[]>(url, options.token);
  }

  async searchModels(query: string, options: Omit<HFListModelsOptions, 'search'> = {}): Promise<HFModel[]> {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return [];
    return this.listModels({
      ...options,
      search: trimmedQuery,
      limit: options.limit ?? 20,
    });
  }

  async getModel(modelId: string, options: { token?: string; expandInferenceProviders?: boolean } = {}): Promise<HFModel> {
    const encodedModelId = encodeURIComponent(modelId);
    const params = new URLSearchParams();
    if (options.expandInferenceProviders) {
      params.set('expand', 'inferenceProviderMapping');
    }
    const query = params.toString();
    const url = `${this.hubBaseUrl}/api/models/${encodedModelId}${query ? `?${query}` : ''}`;
    return this.requestJson<HFModel>(url, options.token);
  }

  async getWhoAmI(token: string): Promise<HFWhoAmI> {
    const url = `${this.hubBaseUrl}/api/whoami-v2`;
    return this.requestJson<HFWhoAmI>(url, token);
  }

  async getWhoAmIWithHeaders(token: string): Promise<HFWhoAmIWithHeaders> {
    const url = `${this.hubBaseUrl}/api/whoami-v2`;
    const response = await this.requestJsonWithHeaders<HFWhoAmI>(url, token);
    return {
      account: response.data,
      rateLimit: response.headers.get('RateLimit'),
      rateLimitPolicy: response.headers.get('RateLimit-Policy'),
    };
  }

  async listRouterModels(token?: string): Promise<HFRouterModel[]> {
    const url = `${this.routerBaseUrl}/v1/models`;
    return this.requestJson<HFRouterModel[]>(url, token);
  }

  private async requestJson<T>(url: string, token?: string): Promise<T> {
    const response = await this.requestJsonWithHeaders<T>(url, token);
    return response.data;
  }

  private async requestJsonWithHeaders<T>(
    url: string,
    token?: string
  ): Promise<{ data: T; headers: Headers }> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: this.buildHeaders(token),
      });
    } catch (error) {
      throw new HubAPIError(
        `Hugging Face API request failed: ${error instanceof Error ? error.message : 'unknown error'}`
      );
    }

    if (!response.ok) {
      let body = '';
      try {
        body = await response.text();
      } catch {
        body = '';
      }
      const detail = body.trim() ? ` - ${body.trim()}` : '';
      throw new HubAPIError(
        `Hugging Face API error (${response.status} ${response.statusText})${detail}`,
        response.status
      );
    }

    try {
      return {
        data: (await response.json()) as T,
        headers: response.headers,
      };
    } catch {
      throw new HubAPIError('Hugging Face API returned invalid JSON');
    }
  }

  private buildHeaders(token?: string): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  }
}
