/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 播放地址改写：把对外输出的 m3u8 地址统一改写成"本站 m3u8 代理"。
 *
 * 目的：去广告在服务端做（见 src/lib/m3u8-ad-filter.ts），但只有真正走本站代理的
 * 请求才会经过那个过滤器。网页端有自己的播放器逻辑，TV / 手机 / 第三方播放器则是
 * 拿到地址就直接播，因此必须让接口吐出的地址本身就指向代理，才能全端生效。
 *
 * 默认关闭（ForceProxyPlayback=false），因为开启后视频流量会经过本站。
 *
 * 注意：对外输出一律拼成**绝对地址**。TV / 手机 / 第三方播放器不一定会拿相对路径
 * 去补全域名，相对地址在它们那边可能直接变成非法 URL。
 */

const M3U8_RE = /\.m3u8(\?|#|$)/i;

export function shouldForceProxyPlayback(config: any): boolean {
  return config?.SiteConfig?.ForceProxyPlayback === true;
}

/**
 * 判断请求是否来自浏览器（网页端）。
 *
 * 网页端自带播放器：hls.js loader 会在浏览器里直接过滤广告，且源站分片多半没有
 * CORS 头，一旦把地址改写成代理 + 分片直连，浏览器会因跨域直接播不了。
 * 因此网页端保持原地址（走浏览器端去广告 / VideoProxy），TV、手机播放器、
 * 第三方这类非浏览器请求才改写成服务端代理。
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

/**
 * 将单个播放地址改写成本站代理地址
 * @param url 原始播放地址
 * @param config 站点配置
 * @param origin 本站 origin（如 https://example.com），传入则输出绝对地址
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

  const allowCORS = config?.SiteConfig?.ProxyPlaybackAllowCORS === true;
  const base = normalizeOrigin(origin);
  return `${base}/api/proxy/m3u8?url=${encodeURIComponent(url)}${
    allowCORS ? '&allowCORS=true' : ''
  }`;
}

/**
 * 批量改写详情接口里的剧集地址
 */
export function wrapEpisodesWithProxy(
  result: any,
  config: any,
  origin?: string,
  skip = false
): any {
  if (!result || !Array.isArray(result.episodes)) return result;
  if (skip) return result; // 网页端：保持原地址
  if (!shouldForceProxyPlayback(config)) return result;
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
  origin?: string,
  skip = false
): any {
  if (!result || typeof result !== 'object') return result;
  if (skip) return result; // 网页端：保持原地址
  if (!shouldForceProxyPlayback(config)) return result;
  if ('url' in result) result.url = wrapPlayUrlWithProxy(result.url, config, origin);
  if ('proxyUrl' in result) {
    result.proxyUrl = wrapPlayUrlWithProxy(result.proxyUrl, config, origin);
  }
  return result;
}
