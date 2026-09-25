import { filterM3U8Ads, isMediaPlaylist, unwrapSegmentUrl } from '@/lib/m3u8-ad-filter';

const build = (segments: Array<[number, string]>, extra = ''): string => {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:10', '#EXT-X-MEDIA-SEQUENCE:0'];
  segments.forEach(([dur, url]) => {
    lines.push(`#EXTINF:${dur.toFixed(1)},`, url);
  });
  if (extra) lines.push(extra);
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
};

describe('m3u8-ad-filter', () => {
  it('master 列表不做过滤', () => {
    const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1280000\nindex.m3u8\n';
    expect(isMediaPlaylist(master)).toBe(false);
    const r = filterM3U8Ads(master);
    expect(r.method).toBe('not-media');
    expect(r.content).toBe(master);
  });

  it('按 URL 关键词移除广告分片并补 DISCONTINUITY', () => {
    const raw = build([
      [10, 'https://cdn.a.com/vod/0.ts'],
      [10, 'https://cdn.a.com/vod/1.ts'],
      [5, 'https://ad.b.com/ad/break001.ts'],
      [5, 'https://ad.b.com/ad/break002.ts'],
      [10, 'https://cdn.a.com/vod/2.ts'],
    ]);
    const r = filterM3U8Ads(raw);
    expect(r.method).toBe('default');
    expect(r.removed).toBe(2);
    expect(r.content).not.toContain('ad.b.com');
    expect(r.content).toContain('#EXT-X-DISCONTINUITY');
  });

  it('EXTINF 中文广告注释命中', () => {
    const raw =
      '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n' +
      '#EXTINF:10.0,\nhttps://cdn.a.com/0.ts\n' +
      '#EXTINF:10.0,广告\nhttps://cdn.a.com/xyz.ts\n' +
      '#EXTINF:10.0,\nhttps://cdn.a.com/1.ts\n#EXT-X-ENDLIST\n';
    const r = filterM3U8Ads(raw);
    expect(r.removed).toBe(1);
    expect(r.content).not.toContain('xyz.ts');
  });

  it('头部被删时修正 EXT-X-MEDIA-SEQUENCE', () => {
    const raw = build([
      [5, 'https://ad.b.com/ad/pre.ts'],
      [10, 'https://cdn.a.com/vod/0.ts'],
      [10, 'https://cdn.a.com/vod/1.ts'],
    ]);
    const r = filterM3U8Ads(raw);
    expect(r.removed).toBe(1);
    expect(r.content).toMatch(/#EXT-X-MEDIA-SEQUENCE:1/);
  });

  it('被删块携带的 EXT-X-KEY 会回填到下一个分片', () => {
    const raw =
      '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n' +
      '#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.a.com/key1.bin"\n' +
      '#EXTINF:5.0,\nhttps://ad.b.com/ad/b1.ts\n' +
      '#EXTINF:10.0,\nhttps://cdn.a.com/vod/0.ts\n' +
      '#EXT-X-ENDLIST\n';
    const r = filterM3U8Ads(raw);
    expect(r.content).not.toContain('ad.b.com');
    expect(r.content).toContain('key1.bin');
  });

  it('删除比例过高时放弃过滤', () => {
    const raw = build([
      [10, 'https://ad.b.com/ad/0.ts'],
      [10, 'https://ad.b.com/ad/1.ts'],
      [10, 'https://ad.b.com/ad/2.ts'],
      [10, 'https://cdn.a.com/vod/0.ts'],
    ]);
    const r = filterM3U8Ads(raw);
    expect(r.method).toBe('aborted');
    expect(r.content).toBe(raw);
  });

  it('自定义代码优先执行', () => {
    const code = `
      function filterAdsFromM3U8(type, m3u8Content) {
        return m3u8Content.split('\\n').filter(function (l) {
          return l.indexOf('BAD') === -1;
        }).join('\\n');
      }
    `;
    const raw = build([
      [10, 'https://cdn.a.com/BAD0.ts'],
      [10, 'https://cdn.a.com/vod/1.ts'],
    ]);
    const r = filterM3U8Ads(raw, { customCode: code, sourceKey: 'test' });
    expect(r.method).toBe('custom');
    expect(r.content).not.toContain('BAD0.ts');
  });

  it('自定义代码抛错时降级到默认规则', () => {
    const code = `function filterAdsFromM3U8() { throw new Error('boom'); }`;
    const raw = build([
      [10, 'https://cdn.a.com/vod/0.ts'],
      [5, 'https://ad.b.com/ad/b1.ts'],
      [10, 'https://cdn.a.com/vod/1.ts'],
    ]);
    const r = filterM3U8Ads(raw, { customCode: code });
    expect(r.method).toBe('default');
    expect(r.content).not.toContain('ad.b.com');
  });

  it('还原被代理包裹的分片地址', () => {
    const wrapped =
      'https://p.example.com/api/proxy/segment?url=https%3A%2F%2Fad.b.com%2Fad%2Fx.ts';
    expect(unwrapSegmentUrl(wrapped)).toBe('https://ad.b.com/ad/x.ts');
  });

  it('enabled=false 时不做任何改动', () => {
    const raw = build([
      [10, 'https://cdn.a.com/vod/0.ts'],
      [5, 'https://ad.b.com/ad/b1.ts'],
    ]);
    const r = filterM3U8Ads(raw, { enabled: false });
    expect(r.method).toBe('disabled');
    expect(r.content).toBe(raw);
  });
});
