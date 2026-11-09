/**
 * RouterAI model prices, host half.
 *
 * Serves GET /routerai-prices on the local web server. The watched list is not
 * hand written: it is read back from the running configuration through the
 * `llm` service, so whichever models this program actually uses are the ones
 * that appear, provider pin included.
 *
 * For each configured model the host pulls the RouterAI endpoint list of its
 * base model and resolves the price in effect right now: the endpoint's base
 * `pricing` with any applicable `variable_pricings` rule layered on top.
 *
 * The endpoints route needs no API key, so the price fetch is anonymous.
 */

export const name = 'routerai-prices'

export const inject = ['webServer', 'llm']

const ROUTE = '/routerai-prices'
const ROUTE_INTERVAL = '/routerai-prices/interval'

/** A configured model id carries its RouterAI provider pin, e.g. `...@provider=relace&allow_fallbacks=false`. */
const PIN = /@provider=([^&]+)/

const PRICE_KEYS = ['prompt', 'completion', 'input_cache_read']

function send(res, body) {
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/** Bounds and fallback for the refresh interval, in minutes. */
const MIN_MINUTES = 1
const MAX_MINUTES = 60
const DEFAULT_MINUTES = 5

/** Clamp the configured interval so a typo can never make the panel hammer the API. */
function intervalMinutes(config) {
  const raw = config && typeof config.intervalMinutes !== 'undefined' ? config.intervalMinutes : DEFAULT_MINUTES
  const value = typeof raw === 'number' && isFinite(raw) ? raw : Number(raw)
  if (!isFinite(value)) return DEFAULT_MINUTES
  return Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(value)))
}

/** Read the whole request body; the setting arrives as a tiny JSON object. */
function readBody(req) {
  return new Promise((resolve) => {
    let text = ''
    req.on('data', (chunk) => {
      text += chunk
      if (text.length > 4096) req.destroy()
    })
    req.on('end', () => resolve(text))
    req.on('error', () => resolve(''))
  })
}

/** `utc_start`/`utc_end` are HHMM in UTC; `utc_days` holds lowercase English weekday names. */
function inWindow(rule, now) {
  const days = rule.utc_days
  if (Array.isArray(days) && days.length > 0) {
    const day = now.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }).toLowerCase()
    if (!days.includes(day)) return false
  }
  const hhmm = now.getUTCHours() * 100 + now.getUTCMinutes()
  const start = typeof rule.utc_start === 'number' ? rule.utc_start : 0
  const end = typeof rule.utc_end === 'number' ? rule.utc_end : 0
  // A window whose end is not greater than its start wraps past midnight.
  return end > start ? hhmm >= start && hhmm < end : hhmm >= start || hhmm < end
}

/**
 * Current price for one endpoint: its base pricing with the first matching
 * time rule layered on top. A `prompt-threshold` rule is not time based, so it
 * applies only once a prompt actually exceeds the threshold; the reported
 * figure is therefore the entry tariff.
 */
function currentPrice(endpoint, now) {
  const base = endpoint.pricing || {}
  const out = {}
  for (const key of PRICE_KEYS) {
    if (typeof base[key] === 'number') out[key] = base[key]
  }
  for (const rule of endpoint.variable_pricings || []) {
    if (rule && rule.type === 'time-of-day' && inWindow(rule, now)) {
      for (const key of PRICE_KEYS) {
        if (typeof rule[key] === 'number') out[key] = rule[key]
      }
      break
    }
  }
  return out
}

/**
 * Vendor of a catalog model. The router ids every model as `author/name`, so the
 * author is read straight from the id; a name is only a human label and is not
 * parsed here. An id without an author is a config typo, not a case to guess at.
 */
function vendorOf(baseId) {
  const at = baseId.indexOf('/')
  return at > 0 ? baseId.slice(0, at) : baseId
}

/** The catalog's own label for one model, with the vendor prefix dropped: "DeepSeek: DeepSeek V4.1 Flash" -> "DeepSeek V4.1 Flash". */
function modelOf(name) {
  const at = name.indexOf(': ')
  return at > 0 ? name.slice(at + 2) : name
}

/**
 * One fetch per base model, shared within a single poll by every pinned variant
 * of that model. Deliberately kept per request: each poll then sees fresh catalog
 * data, and the call needs no auth, so holding it longer saves nothing real.
 */
function infoFor(baseURL, baseId, cache) {
  let pending = cache.get(baseId)
  if (pending === undefined) {
    pending = (async () => {
      const response = await fetch(baseURL + '/models/' + baseId + '/endpoints', {
        signal: AbortSignal.timeout(8000),
      })
      if (!response.ok) throw new Error('http-' + response.status)
      const payload = await response.json()
      const data = (payload && payload.data) || {}
      return {
        model: typeof data.name === 'string' && data.name.length > 0 ? modelOf(data.name) : baseId,
        endpoints: data.endpoints || [],
      }
    })()
    cache.set(baseId, pending)
  }
  return pending
}

/** Longest `model · provider` text kept in full; the rest are trimmed so rows end evenly. */
const LABEL_MAX = 30

/**
 * Clips plain text to `max` characters, counting code points so a surrogate pair
 * is never split. Replaces what it removed with a single `…`.
 */
function clip(text, max) {
  const chars = Array.from(text)
  if (chars.length <= max) return text
  return chars.slice(0, max - 1).join('').trimEnd() + '…'
}

/**
 * The provider serving this variant, plus a marker when it takes images. The
 * whole `model · provider` line is budgeted as one string, so a long model name
 * shortens the provider's share rather than overflowing the column. The marker
 * is appended after clipping, so the picture icon never eats text budget.
 */
function shortLabel(modelName, model, endpoint) {
  const named = typeof endpoint.provider_name === 'string' && endpoint.provider_name.length > 0
    ? endpoint.provider_name
    : endpoint.tag
  const provider = typeof named === 'string' ? named : ''
  const takesImages = Array.isArray(model.inputModalities) && model.inputModalities.includes('image')
  return clip(modelName + ' · ' + provider, LABEL_MAX) + (takesImages ? ' 🖼️' : '')
}

async function collect(ctx, baseURL, provider) {
  const models = await ctx.llm.listModels(provider)
  const now = new Date()
  const cache = new Map()
  const rows = []

  for (const model of models) {
    const id = typeof model.id === 'string' ? model.id : ''
    const pin = PIN.exec(id)
    const baseId = pin === null ? id : id.slice(0, pin.index)
    const vendor = vendorOf(baseId)

    let info
    try {
      info = await infoFor(baseURL, baseId, cache)
    } catch (error) {
      rows.push({ group: vendor, label: baseId, ok: false, error: String((error && error.message) || error) })
      continue
    }

    // RouterAI orders this list by routing priority, so the first endpoint that
    // is not deprioritised is the provider a request would actually go to.
    // A pin replaces that choice with one fixed provider.
    const endpoint = pin === null
      ? info.endpoints.find((entry) => entry && (entry.status === undefined || entry.status >= 0)) || info.endpoints[0]

      : info.endpoints.find((entry) => entry && entry.tag === pin[1])

    if (endpoint === undefined) {
      const why = pin === null ? 'нет доступных провайдеров' : 'провайдер "' + pin[1] + '" не найден'
      rows.push({ group: vendor, label: info.model, ok: false, error: why })
      continue
    }
    rows.push({
      group: vendor,
      label: shortLabel(info.model, model, endpoint),
      ok: true,
      price: currentPrice(endpoint, now),
      // The configured id, pin included: the browser half matches it against the
      // active session's selection to highlight the row in use.
      modelId: id,
    })
  }
  return rows
}

export function apply(ctx, config) {
  const baseURL = (config && config.baseURL) || 'https://routerai.ru/api/v1'
  const provider = (config && config.provider) || 'routerai'
  const minutes = intervalMinutes(config)

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE,
        handler: async (req, res) => {
          try {
            const rows = await collect(ctx, baseURL, provider)
            send(res, { ok: true, at: Date.now(), rows, intervalMs: minutes * 60000 })
          } catch (error) {
            send(res, { ok: false, error: String((error && error.message) || error), intervalMs: minutes * 60000 })
          }
        },
      }),
    'routerai-prices: route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE_INTERVAL,
        handler: async (req, res) => {
          // A deployment without the configuration editor still answers reads.
          const editor = ctx.get('configEditor')
          if (req.method !== 'POST') {
            return send(res, { ok: true, intervalMinutes: minutes, writable: editor !== undefined, min: MIN_MINUTES, max: MAX_MINUTES })
          }

          if (editor === undefined) {
            return send(res, { ok: false, error: 'read-only', writable: false })
          }

          const raw = await readBody(req)
          let parsed
          try {
            parsed = JSON.parse(raw)
          } catch (error) {
            return send(res, { ok: false, error: 'bad-json' })
          }

          const next = parsed && typeof parsed.intervalMinutes !== 'undefined' ? Number(parsed.intervalMinutes) : NaN
          if (!isFinite(next)) return send(res, { ok: false, error: 'bad-number' })

          const bounded = Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(next)))
          const entry = ctx.fiber && ctx.fiber.entry
          if (entry === undefined) return send(res, { ok: false, error: 'no-entry' })

          try {
            await editor.edit(entry, (current) => Object.assign({}, current, { intervalMinutes: bounded }))
          } catch (error) {
            return send(res, { ok: false, error: String((error && error.message) || error) })
          }

          // The loader re-runs this plugin with the new config; report the accepted value.
          send(res, { ok: true, intervalMinutes: bounded, intervalMs: bounded * 60000, writable: true })
        },
      }),
    'routerai-prices: interval route',
  )
}
