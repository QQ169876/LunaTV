/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 播放地址改写：把对外输出的 m3u8 地址统一改写成"本站 m3u8 代理"。
 *
 * 目的：去广告在服务端做（见 src/lib/m3u8-ad-filter.ts），但只有真正走本站代理的
 * 请求才会经过那个过滤器。网页端有自己的播放器逻辑，TV / 手机 / 第三方播放器则是
 * 拿到地址就直接播，因此必须让接口吐出的地址本身就指向代理，才能全端生效。
 *
 * 默认关闭（ForceProxyPlayback=false），因为开启后视频流量会经过本站。
 */

const M3U8_RE = /\.m3u8(\?|#|$)/i;

export function shouldForceProxyPlayback(config: any): boolean {
  return config?.SiteConfig?.ForceProxyPlayback === true;
}

/**
 * 将单个播放地址改写成本站代理地址
 * @param url 原始播放地址
 * @param config 站点配置
 */
export function wrapPlayUrlWithProxy(url: unknown, config: any): unknown {
  if (!shouldForceProxyPlayback(config)) return url;
  if (typeof url !== 'string' || !url) return url;
  if (!M3U8_RE.test(url)) return url; // 只处理 m3u8，mp4 等直链不动
  if (url.startsWith('/api/proxy/m3u8')) return url; // 已改写过，避免套娃

  const allowCORS = config?.SiteConfig?.ProxyPlaybackAllowCORS === true;
  return `/api/proxy/m3u8?url=${encodeURIComponent(url)}${allowCORS ? '&allowCORS=true' : ''}`;
}

/**
 * 批量改写详情接口里的剧集地址
 */
export function wrapEpisodesWithProxy(result: any, config: any): any {
  if (!result || !Array.isArray(result.episodes)) return result;
  if (!shouldForceProxyPlayback(config)) return result;
  result.episodes = result.episodes.map((u: unknown) => wrapPlayUrlWithProxy(u, config));
  return result;
}
