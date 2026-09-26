/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 播放地址改写：把对外输出的 m3u8 地址统一改写成"本站 m3u8 代理"。
 *
 * 目的：去广告在服务端做（见 src/lib/m3u8-ad-filter.ts），但只有真正走本站代理的
 * 请求才会经过那个过滤器。网页端、TV / 手机 / 第三方播放器都必须拿到指向代理的
 * 地址，服务端过滤才会生效。
 *
 * 默认关闭（ForceProxyPlayback=false），因为开启后视频流量会经过本站。
 *
 * 注意：对外输出一律拼成**绝对地址**。TV / 手机 / 第三方播放器不一定会拿相对路径
 * 去补全域名，相对地址在它们那边可能直接变成非法 URL。
 * 只有在拿不到本站域名时（本地直连 / 调试）才退化成相对地址。
 */

const M3U8_RE = /\.m3u8(\?|#|$)/i;

/**
 * 内网 / 回环地址。这类 Host 绝不能出现在对外分发的播放地址里
 * （容器内部 request.url 常常是 0.0.0.0:3000，直接拼出去客户端根本连不上）。
 */
const PRIVATE_HOST_RE =
  /^(?:127\.[\d.]+|10\.[\d.]+|192\.168\.[\d.]+|172\.(?:1[6-9]|2\d|3[01])\.[\d.]+|0\.0\.0\.0|localhost|\[::1\])(?::\d+)?$/i;

export type SegmentProxyMode = 'relay' | 'direct';

/**
 * 决定这一次播放的"视频分片"怎么走。
 *
 * - `relay`：分片经本站 `/api/proxy/segment` 中转。稳定、去广告可靠，
 *   播放器只需要连得上本站；代价是视频流量经过本站。
 * - `direct`：清单仍由本站过滤后返回，分片由播放器直连源站。
 *   省服务器带宽，但取决于播放器所在网络到源站是否通畅。
 *
 * 优先级（后台 > 客户端 > 兜底）：
 * 1. 后台 SiteConfig.ProxyPlaybackMode = 'relay' / 'direct' 时，强制生效，
 *    网页端自己怎么设都不管用；
 * 2. 后台为 'follow'（默认）时，听 URL 里客户端带来的 `seg` 参数；
 * 3. 客户端没表态：网页端按 relay（最易受本地网络影响，中转最稳），
 *    TV / 手机 / 第三方播放器按 direct（它们本来就是这么跑的）。
 */
export function resolveSegmentProxyMode(opts: {
  config?: any;
  requested?: string | null;
  isBrowser?: boolean;
}): SegmentProxyMode {
  const { config, requested, isBrowser } = opts;
  const rawMode = config?.SiteConfig?.ProxyPlaybackMode;
  const pref: SegmentProxyMode | null =
    requested === 'direct' ? 'direct' : requested === 'relay' ? 'relay' : null;

  if (rawMode === 'relay') return 'relay';
  if (rawMode === 'direct') return 'direct';

  // 旧配置（没有 ProxyPlaybackMode）沿用 ProxyPlaybackAllowCORS：
  // 那时只有非浏览器客户端才允许分片直连，浏览器直连会被 CORS 拦。
  if (rawMode !== 'follow') {
    if (config?.SiteConfig?.ProxyPlaybackAllowCORS !== true) return 'relay';
    return isBrowser ? 'relay' : 'direct';
  }

  // 都没明确指定时的兜底：
  // - 网页端（浏览器）：全量中转。它最容易被本地网络到源站的连通性拖累，中转最稳；
  // - TV / 手机 / 第三方播放器：分片直连，沿用它们本来就跑得通的方式，也省服务器带宽。
  if (!pref) return isBrowser ? 'relay' : 'direct';

  return pref;
}

export function shouldForceProxyPlayback(config: any): boolean {
  return config?.SiteConfig?.ForceProxyPlayback === true;
}

/**
 * 判断请求是否来自浏览器（网页端）。
 *
 * 仅用于代理内部的行为微调（例如 allowCORS），**不再用于跳过改写**：
 * 网页端同样要拿代理地址，否则既享受不到服务端去广告，还要靠浏览器直连源站
 * （多数源站没有 CORS 头 / 用户网络未必连得上，表现就是网页端播不动）。
 *
 * 判断依据（浏览器一定带、播放器基本不带）：
 * - Sec-Fetch-Mode / Sec-Fetch-Site（浏览器专属的 Fetch Metadata 头）
 * - Referer 指向播放页（浏览器加载 m3u8 时一定带）
 */
export function isBrowserRequest(request: {
  headers: { get(name: string): string | null };
  url?: string;
}): boolean {
  if (request.headers.get('sec-fetch-mode') || request.headers.get('sec-fetch-site')) {
    return true;
  }
  const referer = request.headers.get('referer');
  if (referer) {
    try {
      const refererHost = new URL(referer).host;
      const selfHost = request.url ? new URL(request.url).host : '';
      if (!selfHost || refererHost === selfHost) return true;
    } catch {
      // referer 解析失败，按非浏览器处理
    }
  }
  return false;
}

function normalizeOrigin(origin?: string): string {
  if (!origin) return '';
  return origin.replace(/\/+$/, '');
}

function firstHeaderValue(value?: string | null): string {
  if (!value) return '';
  return value.split(',')[0].trim();
}

/**
 * 解析"本站对外地址"。
 *
 * 优先级：
 * 1. 后台配置 SiteConfig.SiteBaseUrl
 * 2. 环境变量 SITE_URL / NEXT_PUBLIC_SITE_URL（容器部署时指定最稳）
 * 3. X-Forwarded-Host（nginx 反代会带）+ X-Forwarded-Proto
 * 4. Host 请求头
 * 5. request.url
 *
 * 3~5 若解析出来是内网地址（127.0.0.1 / 0.0.0.0 / 10.x / 192.168.x 等）一律丢弃，
 * 返回空串，由调用方退化成相对地址（同源请求同样可用）。
 */
export function resolvePublicOrigin(
  request?: { headers: { get(name: string): string | null }; url?: string },
  config?: any
): string {
  const cfgBase = config?.SiteConfig?.SiteBaseUrl;
  if (typeof cfgBase === 'string' && cfgBase.trim()) {
    return normalizeOrigin(cfgBase.trim());
  }

  const envBase = (
    process.env.SITE_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    ''
  ).trim();
  if (envBase) return normalizeOrigin(envBase);

  const headers = request?.headers;
  const forwardedHost = firstHeaderValue(headers?.get('x-forwarded-host'));
  const hostHeader = firstHeaderValue(headers?.get('host'));
  const candidate = forwardedHost || hostHeader;

  if (candidate && !PRIVATE_HOST_RE.test(candidate)) {
    const proto = firstHeaderValue(headers?.get('x-forwarded-proto')) || 'https';
    return `${proto}://${candidate}`;
  }

  try {
    const self = new URL(request?.url || '');
    if (self.host && !PRIVATE_HOST_RE.test(self.host)) {
      return self.origin;
    }
  } catch {
    // ignore
  }

  return '';
}

/**
 * 决定输出地址用"绝对"还是"相对"。
 *
 * 网页端一律输出**相对地址**：本站可能通过多个域名 / IP 访问，
 * 相对地址天然同源，既能带上登录 Cookie（分片代理需要），也不会跨站。
 * TV / 手机 / 第三方播放器不会补全相对路径，必须给绝对地址。
 */
function resolveOutputOrigin(
  request?: { headers: { get(name: string): string | null }; url?: string },
  config?: any
): string {
  if (request && isBrowserRequest(request)) return '';
  return resolvePublicOrigin(request, config);
}

/**
 * 将单个播放地址改写成本站代理地址
 * @param url 原始播放地址
 * @param config 站点配置
 * @param origin 本站 origin（如 https://example.com）；留空则输出相对地址
 */
export function wrapPlayUrlWithProxy(
  url: unknown,
  config: any,
  origin?: string
): unknown {
  if (!shouldForceProxyPlayback(config)) return url;
  if (typeof url !== 'string' || !url) return url;
  if (!M3U8_RE.test(url)) return url; // 只处理 m3u8，mp4 等直链不动
  if (url.includes('/api/proxy/m3u8')) return url; // 已改写过，避免套娃

  // 注意：这里**不预先决定**分片该直连还是中转。真正的判定放在 /api/proxy/m3u8
  // （见 resolveSegmentProxyMode），因为那里才拿得到请求头和客户端偏好，
  // 能保证后台策略、客户端设置、旧 allowCORS 参数三者的优先级一致。
  const base = normalizeOrigin(origin);
  return `${base}/api/proxy/m3u8?url=${encodeURIComponent(url)}`;
}

/**
 * 批量改写详情接口里的剧集地址
 *
 * request 传入后会自动解析本站对外域名；解析不到就用相对地址（同源可用）。
 */
export function wrapEpisodesWithProxy(
  result: any,
  config: any,
  request?: { headers: { get(name: string): string | null }; url?: string },
  opts: { skip?: boolean } = {}
): any {
  if (!result || !Array.isArray(result.episodes)) return result;
  if (opts.skip) return result;
  if (!shouldForceProxyPlayback(config)) return result;
  const origin = resolveOutputOrigin(request, config);
  result.episodes = result.episodes.map((u: unknown) =>
    wrapPlayUrlWithProxy(u, config, origin)
  );
  return result;
}

/**
 * 改写"单集解析"类接口（如 /api/shortdrama/parse）返回的地址
 * 只改 url / proxyUrl 两个播放字段，originalUrl 保留原始值便于排查。
 */
export function wrapParsedUrlWithProxy(
  result: any,
  config: any,
  request?: { headers: { get(name: string): string | null }; url?: string },
  opts: { skip?: boolean } = {}
): any {
  if (!result || typeof result !== 'object') return result;
  if (opts.skip) return result;
  if (!shouldForceProxyPlayback(config)) return result;
  const origin = resolveOutputOrigin(request, config);
  if ('url' in result) result.url = wrapPlayUrlWithProxy(result.url, config, origin);
  if ('proxyUrl' in result) {
    result.proxyUrl = wrapPlayUrlWithProxy(result.proxyUrl, config, origin);
  }
  return result;
}
