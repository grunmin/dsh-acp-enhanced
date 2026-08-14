/** dsh web_search provider for OpenAI-Responses gateways (OpenRouter-style `web_search` items). */
export const name: 'web-search-openrouter'
export const inject: ['web']
export interface Config {
  enabled?: boolean
  baseURL?: string
  model?: string
  apiKeyEnv?: string
  searchContextSize?: 'low' | 'medium' | 'high'
  maxOutputTokens?: number
}
export const Config: import('@deepseek-ai/schemastery').Schema<Config>
export function apply(ctx: unknown, config: Config): void
