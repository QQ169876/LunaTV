/**
 * 网页端「视频分片怎么走」的偏好。
 *
 * - `relay`：全量中转 —— 分片经本站 /api/proxy/segment，播放器只连本站。
 *   任何网络、任何设备都稳定，去广告也最可靠；代价是视频流量过服务器。
 * - `direct`：分片直连 —— 清单仍由本站过滤，分片由播放器自己去源站取。
 *   省服务器带宽，但受播放器所在网络到源站的影响。
 *
 * 注意：**后台优先级更高**。后台如果把 ProxyPlaybackMode 设成 relay/direct，
 * 这里存的值就不起作用了（服务端会强制覆盖）。
 */

export type SegmentProxyPreference = 'relay' | 'direct';

export const SEGMENT_PROXY_STORAGE_KEY = 'segmentProxyMode';

/** 默认全量中转：稳定优先 */
export const DEFAULT_SEGMENT_PROXY_PREFERENCE: SegmentProxyPreference = 'relay';

export function readSegmentProxyPreference(): SegmentProxyPreference {
  if (typeof window === 'undefined') return DEFAULT_SEGMENT_PROXY_PREFERENCE;
  try {
    const v = window.localStorage.getItem(SEGMENT_PROXY_STORAGE_KEY);
    return v === 'direct' ? 'direct' : 'relay';
  } catch {
    return DEFAULT_SEGMENT_PROXY_PREFERENCE;
  }
}

export function writeSegmentProxyPreference(value: SegmentProxyPreference): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SEGMENT_PROXY_STORAGE_KEY, value);
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

/**
 * 把客户端偏好写进 m3u8 代理地址。
 * 只对本站 /api/proxy/m3u8 地址生效，其它地址（直源 / mp4 等）原样返回。
 */
export function applySegmentProxyPreference(
  url: unknown,
  preference?: SegmentProxyPreference
): unknown {
  if (typeof url !== 'string' || !url) return url;
  if (!url.includes('/api/proxy/m3u8')) return url;

  const mode = preference || readSegmentProxyPreference();
  try {
    const isRelative = url.startsWith('/');
    const parsed = new URL(
      url,
      typeof window !== 'undefined' && window.location
        ? window.location.href
        : 'https://localhost'
    );
    // 旧参数一并清掉，避免和 seg 打架
    parsed.searchParams.delete('allowCORS');
    parsed.searchParams.set('seg', mode);
    return isRelative ? `${parsed.pathname}${parsed.search}` : parsed.toString();
  } catch {
    return url;
  }
}
