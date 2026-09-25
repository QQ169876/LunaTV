import { filterM3U8Ads } from '@/lib/m3u8-ad-filter';

const head = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:30\n#EXT-X-MEDIA-SEQUENCE:0\n';
const url = (i: number) => `https://cdn.a.com/vod/seg${String(i).padStart(5, '0')}.ts`;

const buildVod = (segments: Array<[number, string]>): string => {
  const lines = [head];
  segments.forEach(([dur, u]) => {
    lines.push(`#EXTINF:${dur.toFixed(1)},\n${u}\n`);
  });
  lines.push('#EXT-X-ENDLIST\n');
  return lines.join('');
};

describe('片头 / 片尾贴片广告', () => {
  it('短剧：片头 20 秒 + 片尾 30 秒整段广告被剔除', () => {
    const segs: Array<[number, string]> = [[20, 'https://cdn.a.com/vod/00000.ts']];
    for (let i = 1; i <= 40; i++) segs.push([5, url(i)]);
    segs.push([30, 'https://cdn.a.com/vod/99999.ts']);

    const r = filterM3U8Ads(buildVod(segs));
    expect(r.removed).toBe(2);
    expect(r.content).not.toContain('00000.ts');
    expect(r.content).not.toContain('99999.ts');
    expect(r.content).toContain('seg00001.ts');
  });

  it('片头连续 3 片 15 秒广告被剔除', () => {
    const segs: Array<[number, string]> = [
      [15, 'https://cdn.a.com/vod/00000.ts'],
      [15, 'https://cdn.a.com/vod/00001.ts'],
      [15, 'https://cdn.a.com/vod/00002.ts'],
    ];
    for (let i = 3; i <= 42; i++) segs.push([5, url(i)]);

    const r = filterM3U8Ads(buildVod(segs));
    expect(r.removed).toBe(3);
    expect(r.content).toContain('seg00003.ts');
  });

  it('外域广告（少数派 URL）被剔除', () => {
    const segs: Array<[number, string]> = [];
    for (let i = 0; i < 4; i++) segs.push([5, url(i)]);
    segs.push([5, 'https://ad.b.com/advert/0001.ts']);
    segs.push([5, 'https://ad.b.com/advert/0002.ts']);
    for (let i = 6; i < 30; i++) segs.push([5, url(i)]);

    const r = filterM3U8Ads(buildVod(segs));
    expect(r.removed).toBe(2);
    expect(r.content).not.toContain('ad.b.com');
  });

  it('正常正片（时长略有波动）不会被误删', () => {
    const segs: Array<[number, string]> = [];
    for (let i = 0; i < 60; i++) segs.push([i % 7 === 0 ? 5.04 : 5, url(i)]);

    const r = filterM3U8Ads(buildVod(segs));
    expect(r.removed).toBe(0);
    expect(r.method).toBe('no-change');
  });

  it('自定义代码之后再跑一遍内置增强规则', () => {
    const customCode = [
      'function filterAdsFromM3U8(type, m3u8Content) {',
      "  const keywords = ['/ad/', '/ads/', 'advert', 'sponsor'];",
      "  const lines = m3u8Content.split('\\n');",
      '  const out = [];',
      '  let i = 0;',
      '  while (i < lines.length) {',
      '    const line = lines[i];',
      "    if (line.includes('#EXT-X-DISCONTINUITY')) { i++; continue; }",
      "    if (line.includes('#EXTINF:')) {",
      "      const next = lines[i + 1] || '';",
      '      if (keywords.some((k) => next.toLowerCase().includes(k))) { i += 2; continue; }',
      '    }',
      '    out.push(line);',
      '    i++;',
      '  }',
      "  return out.join('\\n');",
      '}',
    ].join('\n');

    const segs: Array<[number, string]> = [
      [20, 'https://cdn.a.com/vod/00000.ts'],
      [5, url(1)],
      [5, url(2)],
      [5, url(3)],
      [5, url(4)],
      [5, url(5)],
      [5, url(6)],
      [30, 'https://cdn.a.com/vod/99999.ts'],
    ];

    const r = filterM3U8Ads(buildVod(segs), { customCode });
    expect(r.method).toBe('custom+default');
    expect(r.removed).toBe(2);
    expect(r.content).not.toContain('00000.ts');
    expect(r.content).not.toContain('99999.ts');
  });

  it('直播列表（无 ENDLIST）不做片头片尾与时长离群判定', () => {
    const segs: Array<[number, string]> = [];
    for (let i = 0; i < 20; i++) segs.push([i === 0 ? 20 : 5, url(i)]);
    const raw = buildVod(segs).replace('#EXT-X-ENDLIST\n', '');

    const r = filterM3U8Ads(raw);
    expect(r.removed).toBe(0);
  });
});
