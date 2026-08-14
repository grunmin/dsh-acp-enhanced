/**
 * dsh web_search provider for OpenAI-Responses gateways that implement the
 * native `web_search` server tool.
 *
 * OpenAI-Responses gateways route chat through the OpenAI Responses API and
 * expose a server-side `web_search` tool that returns `openrouter:web_search`
 * output items carrying `action.sources[]`. DeepSeek's shipped search provider
 * (`dsh-web-search-deepseek`) does NOT talk to such gateways — it speaks
 * Anthropic's `/messages` + `web_search_20250305`, which these gateways
 * typically 503. This package registers a provider that uses the gateway's
 * own `/responses` endpoint instead, so `web`/`tool-web` search reuses the
 * same credential/route as chat (no separate DeepSeek search key needed).
 *
 * The provider is registered under the id `openai-responses`; point the
 * `web` row's `searchProvider` at it to select it (see README).
 *
 * @module dsh-web-search-openrouter
 */
import Schema from '@deepseek-ai/schemastery'

export const name = 'web-search-openrouter'

/** Requires the `web` seam (provided by `dsh-web`, mounted in dsh-base). */
export const inject = ['web']

export const Config = Schema.object({
  /** Set false to register nothing (the row stays inert). */
  enabled: Schema.boolean().default(true),
  /** Gateway base URL; `/responses` is appended. */
  baseURL: Schema.string(),
  /** Model id the gateway exposes for the search turn. */
  model: Schema.string(),
  /** Credential ref (apiKeyEnv) or env var name carrying the gateway key. */
  apiKeyEnv: Schema.string().default('RESPONSES_API_KEY'),
  /** OpenAI `web_search` tool `search_context_size` ('low' | 'medium' | 'high'). */
  searchContextSize: Schema.string().default('medium'),
  /** Bound on the synthesized answer; the search-item sources always come back. */
  maxOutputTokens: Schema.number().default(1024),
})

/** Resolve the gateway key through the credentials service, then the env. */
function resolveKey(ctx, apiKeyEnv) {
  const resolve = async () => {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(apiKeyEnv)
      if (hit?.value !== undefined && hit.value.length > 0) return hit.value
    }
    const ambient = process.env[apiKeyEnv]
    return ambient !== undefined && ambient.length > 0 ? ambient : undefined
  }
  return resolve
}

/** Normalize one gateway response into deduped source entries. */
function collectSources(output) {
  const sources = []
  for (const item of output ?? []) {
    if (item.type !== 'openrouter:web_search' || item.action?.type !== 'search') continue
    for (const source of item.action.sources ?? []) {
      if (source?.url == null || source.url.length === 0) continue
      sources.push({
        url: source.url,
        ...(source.title != null ? { title: source.title } : {}),
        ...(source.snippet != null ? { snippet: source.snippet } : {}),
      })
    }
  }
  const seen = new Set()
  return sources.filter((source) => !seen.has(source.url) && seen.add(source.url))
}

/** Optional synthesized answer from the final `message` output item. */
function collectAnswer(output) {
  for (const item of output ?? []) {
    if (item.type !== 'message') continue
    const text = (item.content ?? [])
      .filter((block) => block.type === 'output_text')
      .map((block) => block.text)
      .join('')
    if (text !== undefined && text.length > 0) return text
  }
  return undefined
}

/** Mount the provider: register the `openai-responses` search provider on ctx.web. */
export function apply(ctx, config) {
  if (!config.enabled) return
  const keyOf = resolveKey(ctx, config.apiKeyEnv)
  const provider = {
    id: 'openai-responses',
    available: () => true,
    search: async (request, signal) => {
      const key = await keyOf()
      if (key === undefined) {
        throw new Error(`web-search-openrouter: no API key for "${config.apiKeyEnv}"; store it through the credentials service or export it`)
      }
      const res = await fetch(`${config.baseURL}/responses`, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: config.model,
          input: request.query,
          tools: [{ type: 'web_search', search_context_size: config.searchContextSize }],
          max_output_tokens: config.maxOutputTokens,
        }),
      })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(`web-search-openrouter: HTTP ${res.status} ${detail.slice(0, 200)}`)
      }
      const data = await res.json()
      const sources = collectSources(data.output ?? [])
      if (sources.length === 0) {
        throw new Error('web-search-openrouter: gateway returned no sources')
      }
      const answer = collectAnswer(data.output ?? [])
      return { sources, ...(answer !== undefined ? { answer } : {}) }
    },
  }
  ctx.effect(() => ctx.web.registerSearchProvider(provider), 'web-search-openrouter.provider')
  ctx.logger.info(`web-search-openrouter: registered search provider "openai-responses" -> ${config.baseURL}/responses (model ${config.model})`)
}
