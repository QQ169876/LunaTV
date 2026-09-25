/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 服务端 M3U8 去广告引擎
 *
 * 设计目标：把"去广告"从浏览器端（hls.js 自定义 loader）搬到服务端，
 * 让所有客户端（网页 / TV / 手机 / 第三方播放器）拿到的 m3u8 都是已经过滤干净的。
 *
 * 关键原则：
 * 1. 只在服务端执行，不依赖 document / window / hls.js，Node 运行时可直接跑。
 * 2. 优先执行管理员在后台配置的自定义代码（CustomAdFilterCode，函数签名
 *    filterAdsFromM3U8(type, m3u8Content)），与原先浏览器端的行为保持一致；
 *    自定义代码出错或返回非法内容时，自动降级到内置默认规则。
 * 3. 删除广告分片时，必须连同其前置标记行（EXTINF / BYTERANGE / DISCONTINUITY /
 *    PROGRAM-DATE-TIME / DATERANGE 等）一起删，不留悬空标记。
 * 4. 删除后做连续性修复：补 EXT-X-DISCONTINUITY、回填被删块带走的 KEY/MAP、
 *    修正被删头部导致的 EXT-X-MEDIA-SEQUENCE 偏移。
 * 5. 任何一步判定信心不足（删得太多 / 删完不合法），一律原样返回，宁可漏删不可误删。
 */

/** 过滤结果 */
export interface AdFilterResult {
  /** 过滤后的 m3u8 内容（未过滤时原样返回） */
  content: string;
  /** 被移除的分片数 */
  removed: number;
  /** 过滤前的分片总数（master 列表为 0） */
  total: number;
  /** 实际采用的过滤方式 */
  method: 'custom' | 'default' | 'disabled' | 'not-media' | 'no-change' | 'aborted';
  /** 中止/降级原因，便于排查 */
  reason?: string;
}

export interface AdFilterOptions {
  /** 播放源 key，透传给自定义代码 */
  sourceKey?: string | null;
  /** 管理员配置的自定义去广告代码 */
  customCode?: string;
  /** 是否启用（总开关） */
  enabled?: boolean;
  /** 单条列表最多允许删除的分片占比，超过则放弃本次过滤，默认 0.5 */
  maxRemoveRatio?: number;
}

/** URL 关键词：命中即判定为广告分片 */
const URL_AD_PATTERNS: RegExp[] = [
  /\/ad\//i,
  /\/ads\//i,
  /\/ad_[a-z0-9]+\//i,
  /\/advert/i,
  /\/advertisement/i,
  /\/admaster/i,
  /\/adslot/i,
  /\/adbreak/i,
  /\/ad-break/i,
  /\/adjump/i,
  /\/preroll/i,
  /\/pre-roll/i,
  /\/midroll/i,
  /\/mid-roll/i,
  /\/postroll/i,
  /\/post-roll/i,
  /[?&](ad|ads|adtype|adid|adidx)=/i,
  /[?&](utm_|clickid|affiliate_id)/i,
  /sponsor/i,
  /redtraffic/i,
  /doubleclick/i,
  /googlesyndication/i,
  /\/(gg|guanggao)\//i,
  /\/vast\//i,
  /\/vpaid\//i,
  /\/ima\//i,
];

/** EXTINF 行尾注释里的中文广告词 */
const COMMENT_AD_WORDS = ['广告', '贴片', '赞助', '推广', '广吿', 'AD'];

/** 广告标记行（整行删除，不参与分片配对） */
const AD_MARKER_PREFIXES = [
  '#EXT-X-CUE-OUT',
  '#EXT-X-CUE-IN',
  '#EXT-OATCLS-SCTE35',
  '#EXT-X-SCTE35',
  '#EXT-X-ASSET',
  '#EXT-X-AD',
  '#EXT-X-AD-INSERTION',
];

/** 需要跨删除块保留的状态型标签 */
const CARRY_TAG_PREFIXES = ['#EXT-X-KEY', '#EXT-X-MAP'];

/** 单个分片 */
interface Segment {
  /** 紧邻该分片之前的标记行（按顺序） */
  tags: string[];
  /** 分片地址 */
  url: string;
  /** EXTINF 时长，解析失败为 null */
  duration: number | null;
  /** EXTINF 行尾注释 */
  comment: string;
}

/** 解析后的播放列表 */
interface ParsedPlaylist {
  /** 头部行（第一个分片之前的所有行，含 #EXTM3U、TARGETDURATION 等） */
  header: string[];
  segments: Segment[];
  /** 尾部行（最后一个分片之后的所有行，通常是 #EXT-X-ENDLIST） */
  tail: string[];
}

function parseDuration(tagLine: string): number | null {
  const m = tagLine.match(/^#EXTINF:\s*(-?\d+(?:\.\d+)?)/);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return Number.isFinite(v) ? v : null;
}

function parseComment(tagLine: string): string {
  const idx = tagLine.indexOf(',');
  return idx >= 0 ? tagLine.slice(idx + 1).trim() : '';
}

function isAdMarker(line: string): boolean {
  const upper = line.toUpperCase();
  if (AD_MARKER_PREFIXES.some((p) => upper.startsWith(p))) return true;
  // SCTE35 日期范围：带广告投放信号的 DATERANGE，整行删掉
  if (upper.startsWith('#EXT-X-DATERANGE')) {
    return /SCTE35|CUE-OUT|CUE-IN|AD-IN|AD-OUT/i.test(line);
  }
  return false;
}

/**
 * 还原被代理地址包裹的真实分片地址。
 * 部分源（如 mtdl 一类）的分片长这样：
 *   https://proxy.example.com/api/proxy/segment?url=https%3A%2F%2Fad.cdn%2Fad%2F001.ts
 * 不解码的话所有分片看起来都在同一个域名下，域名/路径类信号全部失效。
 */
export function unwrapSegmentUrl(url: string, maxDepth = 3): string {
  let cur = url;
  for (let i = 0; i < maxDepth; i++) {
    const m = cur.match(/[?&]url=([^&]+)/i);
    if (!m) break;
    let decoded: string;
    try {
      decoded = decodeURIComponent(m[1]);
    } catch {
      decoded = m[1];
    }
    if (!decoded || decoded === cur) break;
    cur = decoded;
  }
  return cur;
}

function isAdUrl(url: string): boolean {
  return URL_AD_PATTERNS.some((re) => re.test(url));
}

function isAdComment(comment: string): boolean {
  if (!comment) return false;
  return COMMENT_AD_WORDS.some((w) => comment.includes(w));
}

function parsePlaylist(raw: string): ParsedPlaylist {
  const lines = raw.split(/\r?\n/);
  const header: string[] = [];
  const tail: string[] = [];
  const segments: Segment[] = [];
  let pending: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) continue;

    if (line.startsWith('#')) {
      // 广告标记行直接丢弃，不进入 pending，避免误配到下一个分片
      if (isAdMarker(line)) continue;
      pending.push(rawLine);
      continue;
    }

    // 非空非注释行 = 分片地址（或 master 列表里的子列表地址）
    const tags = pending;
    pending = [];

    let duration: number | null = null;
    let comment = '';
    for (const t of tags) {
      const trimmed = t.trim();
      if (trimmed.startsWith('#EXTINF')) {
        duration = parseDuration(trimmed);
        comment = parseComment(trimmed);
        break;
      }
    }

    segments.push({ tags, url: rawLine.trim(), duration, comment });
  }

  // 剩余未配对的行归到尾部
  tail.push(...pending);

  // 头部 = 第一个分片之前的行（解析时它们被塞进了第一个分片的 tags，需要回切）
  if (segments.length > 0) {
    const first = segments[0];
    const firstExtinf = first.tags.findIndex((t) => t.trim().startsWith('#EXTINF'));
    if (firstExtinf >= 0) {
      header.push(...first.tags.slice(0, firstExtinf));
      first.tags = first.tags.slice(firstExtinf);
    } else {
      // 没有 EXTINF（异常情况），尽量把非分片相关标签留在头部
      const keep: string[] = [];
      const rest: string[] = [];
      for (const t of first.tags) {
        if (t.trim().startsWith('#EXT-X-KEY') || t.trim().startsWith('#EXT-X-MAP')) {
          keep.push(t);
        } else {
          rest.push(t);
        }
      }
      header.push(...rest);
      first.tags = keep;
    }
  } else {
    header.push(...tail.splice(0, tail.length));
  }

  return { header, segments, tail };
}

/** 判断是否为 media 播放列表（含 EXTINF），master 列表不参与过滤 */
export function isMediaPlaylist(raw: string): boolean {
  return /^\s*#EXTINF:/m.test(raw);
}

function serialize(p: ParsedPlaylist): string {
  const out: string[] = [...p.header];
  for (const s of p.segments) {
    out.push(...s.tags, s.url);
  }
  out.push(...p.tail);
  // 补回结尾换行，保持与常见 m3u8 一致
  return out.join('\n') + '\n';
}

/** 内置默认规则：返回被判定为广告的分片下标集合 */
function detectAdSegments(segments: Segment[]): Set<number> {
  const hits = new Set<number>();

  // 规则 1：CUE-OUT 与 CUE-IN 之间整段视为广告（标记行已在解析阶段剔除，
  // 这里通过"分片是否夹在被剔除的标记之间"无法还原，因此改用 URL/时长判定兜底）
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (isAdUrl(unwrapSegmentUrl(s.url)) || isAdComment(s.comment)) hits.add(i);
  }

  // 规则 2：时长异常。只在"异常片占比很小"时才采信，避免主流时长被误判
  const total = segments.length;
  if (total >= 8) {
    const outliers: number[] = [];
    for (let i = 0; i < total; i++) {
      const d = segments[i].duration;
      if (d === null) continue;
      if (d <= 0.2 || d >= 120) outliers.push(i);
    }
    if (outliers.length > 0 && outliers.length <= Math.max(2, Math.floor(total * 0.2))) {
      outliers.forEach((i) => hits.add(i));
    }
  }

  return hits;
}

/**
 * 删除指定分片并做连续性修复
 * @returns 实际删除数（因安全阈值放弃时返回 -1）
 */
function removeSegments(segments: Segment[], toRemove: Set<number>): Segment[] | null {
  if (toRemove.size === 0) return segments;

  const kept: Segment[] = [];
  let carry: string[] = [];

  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const isRemoved = toRemove.has(i);

    // 被删块携带的 KEY/MAP 需要回填到下一个保留分片之前
    const carriedTags = s.tags.filter((t) =>
      CARRY_TAG_PREFIXES.some((p) => t.trim().startsWith(p))
    );

    if (isRemoved) {
      carry = carriedTags.length > 0 ? carriedTags : carry;
      continue;
    }

    const nextSeg: Segment = { ...s, tags: [...s.tags] };

    // 删除块之后补 DISCONTINUITY（首尾的情况不需要）
    const prevRemoved = i > 0 && toRemove.has(i - 1);
    if (prevRemoved && carry.length === 0) {
      const hasDisc = nextSeg.tags.some((t) => t.trim().startsWith('#EXT-X-DISCONTINUITY'));
      if (!hasDisc) {
        const extinfIdx = nextSeg.tags.findIndex((t) => t.trim().startsWith('#EXTINF'));
        const disc = '#EXT-X-DISCONTINUITY';
        if (extinfIdx >= 0) nextSeg.tags.splice(extinfIdx, 0, disc);
        else nextSeg.tags.unshift(disc);
      }
    }

    // 回填被删块带走的 KEY/MAP（保留分片自身已有同名标签时不重复插入）
    if (carry.length > 0) {
      const extinfIdx = nextSeg.tags.findIndex((t) => t.trim().startsWith('#EXTINF'));
      for (const t of carry) {
        const prefix = t.trim().split(':')[0];
        const already = nextSeg.tags.some((x) => x.trim().startsWith(prefix));
        if (already) continue;
        if (extinfIdx >= 0) nextSeg.tags.splice(extinfIdx, 0, t);
        else nextSeg.tags.unshift(t);
      }
      carry = [];
    }

    kept.push(nextSeg);
  }

  return kept;
}

/** 修正 EXT-X-MEDIA-SEQUENCE：头部被删 N 片时，起始序号要 +N */
function fixMediaSequence(header: string[], removedFromHead: number): string[] {
  if (removedFromHead <= 0) return header;
  const idx = header.findIndex((l) => /^#EXT-X-MEDIA-SEQUENCE:/i.test(l.trim()));
  if (idx < 0) return header;
  const m = header[idx].match(/(\d+)/);
  if (!m) return header;
  const next = parseInt(m[1], 10) + removedFromHead;
  const copy = [...header];
  copy[idx] = copy[idx].replace(/\d+/, String(next));
  return copy;
}

function countRemovedFromHead(segments: Segment[], toRemove: Set<number>): number {
  let n = 0;
  for (let i = 0; i < segments.length; i++) {
    if (toRemove.has(i)) n++;
    else break;
  }
  return n;
}

/**
 * 列表里是否带显式广告标记（SCTE35 系列）。
 *
 * 有显式标记说明上游确实做了广告插入，此时可以放宽删除比例阈值——
 * 否则短列表（例如只有 6 片、其中 4 片广告）会因为占比过高被安全阀拦下，反而漏删。
 */
function hasExplicitAdMarkers(raw: string): boolean {
  return (
    /#EXT-X-CUE-OUT/i.test(raw) ||
    /#EXT-X-CUE-IN/i.test(raw) ||
    /#EXT-OATCLS-SCTE35/i.test(raw) ||
    /#EXT-X-SCTE35/i.test(raw) ||
    /#EXT-X-ASSET/i.test(raw) ||
    /#EXT-X-DATERANGE[^\n]*SCTE35/i.test(raw)
  );
}

/**
 * 内置默认过滤（不含自定义代码）
 */
export function filterWithDefaultRules(
  raw: string,
  maxRemoveRatio = 0.5
): AdFilterResult {
  if (!isMediaPlaylist(raw)) {
    return { content: raw, removed: 0, total: 0, method: 'not-media' };
  }

  // 有显式广告标记时放宽到 0.8，仍然保留兜底（不会把整片正片删光）
  const effectiveRatio = hasExplicitAdMarkers(raw)
    ? Math.max(maxRemoveRatio, 0.8)
    : maxRemoveRatio;

  const parsed = parsePlaylist(raw);
  const total = parsed.segments.length;
  if (total === 0) {
    return { content: raw, removed: 0, total: 0, method: 'no-change' };
  }

  const toRemove = detectAdSegments(parsed.segments);
  if (toRemove.size === 0) {
    return { content: raw, removed: 0, total, method: 'no-change' };
  }

  // 安全阀：删太多说明判定可能反了，直接放弃
  if (toRemove.size / total > effectiveRatio) {
    return {
      content: raw,
      removed: 0,
      total,
      method: 'aborted',
      reason: `命中 ${toRemove.size}/${total} 片，超过阈值 ${effectiveRatio}，放弃过滤`,
    };
  }

  const removedFromHead = countRemovedFromHead(parsed.segments, toRemove);
  const kept = removeSegments(parsed.segments, toRemove);
  if (!kept || kept.length === 0) {
    return {
      content: raw,
      removed: 0,
      total,
      method: 'aborted',
      reason: '过滤后无剩余分片，放弃过滤',
    };
  }

  parsed.segments = kept;
  parsed.header = fixMediaSequence(parsed.header, removedFromHead);

  return {
    content: serialize(parsed),
    removed: toRemove.size,
    total,
    method: 'default',
  };
}

/* -------------------------------------------------------------------------- */
/*  自定义代码执行（与浏览器端行为对齐）                                        */
/* -------------------------------------------------------------------------- */

interface CustomFnCacheEntry {
  code: string;
  fn: (type: string, content: string) => unknown;
}

let customFnCache: CustomFnCacheEntry | null = null;

/** 去掉常见 TypeScript 类型注解，让后台粘贴的 TS 代码能在 new Function 里跑 */
function stripTypes(code: string): string {
  return code
    .replace(/(\w+)\s*:\s*(string|number|boolean|any|void|never|unknown|object)\s*([,)])/g, '$1$3')
    .replace(/\)\s*:\s*(string|number|boolean|any|void|never|unknown|object)\s*\{/g, ') {')
    .replace(
      /(const|let|var)\s+(\w+)\s*:\s*(string|number|boolean|any|void|never|unknown|object)\s*=/g,
      '$1 $2 ='
    );
}

function compileCustomCode(code: string): CustomFnCacheEntry | null {
  try {
    const jsCode = stripTypes(code);
    // eslint-disable-next-line no-new-func
    const factory = new Function(
      'type',
      'm3u8Content',
      `${jsCode}\nreturn filterAdsFromM3U8(type, m3u8Content);`
    ) as (type: string, content: string) => unknown;
    return { code, fn: factory };
  } catch {
    return null;
  }
}

function getCustomFn(code: string): CustomFnCacheEntry | null {
  if (customFnCache && customFnCache.code === code) return customFnCache;
  customFnCache = compileCustomCode(code);
  return customFnCache;
}

function isValidFilteredContent(out: unknown, raw: string): boolean {
  if (typeof out !== 'string' || out.trim().length === 0) return false;
  if (!out.includes('#EXTM3U')) return false;
  // 过滤后至少要剩一个分片，否则视为失败
  if (!/^\s*#EXTINF:/m.test(out)) return false;
  // 长度异常缩小（自定义代码写崩了）也判失败
  if (out.length < raw.length * 0.05) return false;
  return true;
}

/**
 * 服务端去广告主入口
 *
 * @param raw 原始 m3u8 内容
 * @param options 过滤选项
 */
export function filterM3U8Ads(raw: string, options: AdFilterOptions = {}): AdFilterResult {
  const {
    sourceKey = null,
    customCode = '',
    enabled = true,
    maxRemoveRatio = 0.5,
  } = options;

  if (!enabled) {
    return { content: raw, removed: 0, total: 0, method: 'disabled' };
  }

  if (!raw || raw.trim().length === 0) {
    return { content: raw, removed: 0, total: 0, method: 'not-media' };
  }

  if (!isMediaPlaylist(raw)) {
    // master 列表：不做过滤，交给上层把子列表继续走代理
    return { content: raw, removed: 0, total: 0, method: 'not-media' };
  }

  // 1) 自定义代码优先
  if (customCode && customCode.trim()) {
    const entry = getCustomFn(customCode);
    if (entry) {
      try {
        const out = entry.fn(sourceKey || '', raw);
        if (isValidFilteredContent(out, raw)) {
          const before = (raw.match(/^\s*#EXTINF:/gm) || []).length;
          const after = ((out as string).match(/^\s*#EXTINF:/gm) || []).length;
          return {
            content: out as string,
            removed: Math.max(0, before - after),
            total: before,
            method: 'custom',
          };
        }
        return {
          ...filterWithDefaultRules(raw, maxRemoveRatio),
          reason: '自定义代码返回非法内容，已降级到默认规则',
        };
      } catch (err) {
        return {
          ...filterWithDefaultRules(raw, maxRemoveRatio),
          reason: `自定义代码执行异常，已降级到默认规则: ${(err as Error).message}`,
        };
      }
    }
    return {
      ...filterWithDefaultRules(raw, maxRemoveRatio),
      reason: '自定义代码编译失败，已降级到默认规则',
    };
  }

  // 2) 内置默认规则
  return filterWithDefaultRules(raw, maxRemoveRatio);
}
