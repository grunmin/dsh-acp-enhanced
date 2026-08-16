# dsh-web-search-openrouter

A `ctx.web` search provider for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(`dsh`) that routes `web_search` through any OpenAI-Responses gateway implementing the
native `web_search` server tool (OpenRouter-style items), instead of DeepSeek's
Anthropic `/messages` endpoint.

It is intentionally decoupled from the `dsh-acp-enhanced` bridge: it can be mounted in
any profile, including the Web GUI.

## Install

```sh
dsh plugin --profile <name> add dsh-web-search-openrouter
```

## Configure

Append two blocks to the profile's `cordis.patch.yml`:

```yaml
- id: web
  config:
    searchProvider: openai-responses

- insert:
    - id: web-search-openrouter
      name: 'dsh-web-search-openrouter'
      config:
        enabled: true
        baseURL: http://<gateway-host>:<port>/v1
        model: <your-model-id>
        apiKeyEnv: <KEY_ENV_NAME>
```

> `searchProvider` must be exactly `openai-responses` — the search provider id this
> package registers on `ctx.web` (see the `apply` hook). It is **not** your gateway's LLM
> provider id: the `web` plugin matches it exactly, so a wrong value produces no error at
> config time and only fails at the first search with `WEB_PROVIDER_CONFIGURED_MISSING`.

## License

MIT
