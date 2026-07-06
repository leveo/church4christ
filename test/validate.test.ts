import { describe, it, expect } from 'vitest';
import {
  isHttpUrl,
  parseBulletinForm,
  parseSermonForm,
  parsePrayerSheetForm,
  parseAnnouncementForm,
  parseEventForm,
  parsePersonForm,
  parseSettingsForm,
  parseBlockoutForm,
  parseApplicationForm,
} from '../src/lib/validate';

const fdOf = (entries: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
};

describe('isHttpUrl', () => {
  it('accepts only http/https URLs', () => {
    expect(isHttpUrl('https://a.example/x')).toBe(true);
    expect(isHttpUrl('http://a.example')).toBe(true);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('notaurl')).toBe(false);
  });
});

function baseBulletinFd(): FormData {
  const fd = new FormData();
  fd.set('service_type_id', '2');
  fd.set('bulletin_date', '2026-07-05');
  fd.set('service_time_label', '主日崇拜 10:00');
  fd.append('program_item', '序樂'); fd.append('program_content', ''); fd.append('program_person', '司琴');
  fd.append('program_item', ''); fd.append('program_content', ''); fd.append('program_person', ''); // blank row → skipped
  fd.append('offering_label', '經常費'); fd.append('offering_amount', '12,345');
  fd.append('offering_label', ''); fd.append('offering_amount', '');
  fd.append('attendance_label', '中文堂'); fd.append('attendance_count', '180');
  fd.append('ann_title', '主日學'); fd.append('ann_body', '主日學開放報名'); fd.append('ann_url', 'https://church.example/x'); fd.append('ann_label', '點擊報名');
  fd.append('ann_title', ''); fd.append('ann_body', ''); fd.append('ann_url', ''); fd.append('ann_label', '');
  fd.set('memory_verse', '約 3:16');
  fd.set('flowers', '');
  fd.set('status', 'published');
  fd.set('publish_at', '2026-07-03T18:00');
  return fd;
}

describe('parseBulletinForm', () => {
  it('parses a full form, skips blank rows, converts publish_at to UTC', () => {
    const r = parseBulletinForm(baseBulletinFd());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.serviceTypeId).toBe(2);
    expect(r.data.bulletinDate).toBe('2026-07-05');
    expect(r.data.serviceTimeLabel).toBe('主日崇拜 10:00');
    expect(r.data.program).toEqual([{ item: '序樂', content: '', person: '司琴' }]);
    expect(r.data.offering).toEqual([{ label: '經常費', amount: '12,345' }]);
    expect(r.data.attendance).toEqual([{ label: '中文堂', count: '180' }]);
    expect(r.data.announcements).toEqual([
      { title: '主日學', body: '主日學開放報名', linkUrl: 'https://church.example/x', linkLabel: '點擊報名' },
    ]);
    expect(r.data.memoryVerse).toBe('約 3:16');
    expect(r.data.flowers).toBeNull();
    expect(r.data.status).toBe('published');
    // 2026-07-03 18:00 America/Chicago is CDT (UTC-5)
    expect(r.data.publishAt).toBe('2026-07-03 23:00:00');
  });
  it('requires a service_type_id and a valid bulletin_date', () => {
    const fd = baseBulletinFd();
    fd.set('service_type_id', '');
    fd.set('bulletin_date', '2026-13-01');
    const r = parseBulletinForm(fd);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.service_type_id).toBe('errors.required');
    expect(r.errors.bulletin_date).toBe('errors.dateFormat');
  });
  it('rejects non-http announcement links', () => {
    const fd = baseBulletinFd();
    fd.append('ann_title', ''); fd.append('ann_body', 'x'); fd.append('ann_url', 'javascript:alert(1)'); fd.append('ann_label', '');
    const r = parseBulletinForm(fd);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.ann_url_2).toBe('errors.urlInvalid');
  });
  it('requires body when an announcement row has only a link', () => {
    const fd = baseBulletinFd();
    fd.append('ann_title', ''); fd.append('ann_body', ''); fd.append('ann_url', 'https://a.example'); fd.append('ann_label', '');
    const r = parseBulletinForm(fd);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.ann_body_2).toBe('errors.required');
  });
  it('rejects an unparseable publish_at', () => {
    const fd = baseBulletinFd();
    fd.set('publish_at', 'garbage');
    const r = parseBulletinForm(fd);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.publish_at).toBe('errors.datetimeInvalid');
  });
});

function sermonFd(): FormData {
  const fd = new FormData();
  fd.set('service_type_id', '1');
  fd.set('sermon_date', '2026-08-09');
  fd.set('title', '同行的呼召');
  fd.set('speaker', '池金代 牧師');
  fd.set('scripture', '路加福音 24:13-35');
  fd.set('youtube', 'https://www.youtube.com/watch?v=M7lc1UVf-VE');
  fd.set('series', '');
  fd.set('status', 'published');
  return fd;
}

describe('parseSermonForm', () => {
  it('extracts the YouTube id from a full URL and nulls blank optionals', () => {
    const r = parseSermonForm(sermonFd());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual({
      serviceTypeId: 1, sermonDate: '2026-08-09', title: '同行的呼召', speaker: '池金代 牧師',
      scripture: '路加福音 24:13-35', youtubeId: 'M7lc1UVf-VE', series: null, status: 'published',
    });
  });
  it('accepts a blank youtube field as null', () => {
    const fd = sermonFd(); fd.set('youtube', '');
    const r = parseSermonForm(fd);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.youtubeId).toBeNull();
  });
  it('rejects unrecognizable YouTube input when present', () => {
    const fd = sermonFd(); fd.set('youtube', 'https://vimeo.com/12345');
    const r = parseSermonForm(fd);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.youtube).toBe('errors.youtubeInvalid');
  });
  it('requires a valid date and a title', () => {
    const fd = sermonFd(); fd.set('sermon_date', ''); fd.set('title', ' ');
    const r = parseSermonForm(fd);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.sermon_date).toBe('errors.dateFormat');
    expect(r.errors.title).toBe('errors.required');
  });
});

describe('parsePrayerSheetForm', () => {
  it('splits textarea lines into items and skips empty lines and fully-empty sections', () => {
    const fd = new FormData();
    fd.set('sheet_date', '2026-08-05');
    fd.set('locale', 'zh');
    fd.append('section_heading', '感恩'); fd.append('section_items', '為主日崇拜感恩\n\n  為同工感恩  \n');
    fd.append('section_heading', ''); fd.append('section_items', '');
    fd.set('status', 'published');
    fd.set('publish_at', '2026-08-05T08:00');
    const r = parsePrayerSheetForm(fd);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.locale).toBe('zh');
    expect(r.data.sections).toEqual([{ heading: '感恩', items: ['為主日崇拜感恩', '為同工感恩'] }]);
    // 2026-08-05 08:00 Chicago is CDT (UTC-5)
    expect(r.data.publishAt).toBe('2026-08-05 13:00:00');
  });
  it('errors when items exist under a blank heading', () => {
    const fd = new FormData();
    fd.set('sheet_date', '2026-08-05');
    fd.append('section_heading', ''); fd.append('section_items', '有內容但沒標題');
    fd.set('status', 'draft');
    const r = parsePrayerSheetForm(fd);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.section_heading_0).toBe('errors.required');
  });
  it('requires a valid sheet_date and rejects an unknown locale', () => {
    const r = parsePrayerSheetForm(fdOf({ sheet_date: 'not-a-date', locale: 'fr', status: 'draft' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.sheet_date).toBe('errors.dateFormat');
    expect(r.errors.locale).toBe('errors.invalidOption');
  });
});

describe('parseAnnouncementForm', () => {
  it('collects per-locale titles; blank sort → 0; missing checkbox → inactive', () => {
    const fd = fdOf({ title_en: 'Sunday School', title_zh: '主日學報名', url: '', sort: '', starts_at: '', ends_at: '2026-09-01' });
    const r = parseAnnouncementForm(fd);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual({
      titles: { en: 'Sunday School', zh: '主日學報名' }, url: null, sort: 0, active: false, startsAt: null, endsAt: '2026-09-01',
    });
  });
  it('accepts a single-locale title and stores only that locale', () => {
    const r = parseAnnouncementForm(fdOf({ title_en: '', title_zh: '只有中文', active: 'on' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.titles).toEqual({ zh: '只有中文' });
    expect(r.data.active).toBe(true);
  });
  it('requires at least one locale title and rejects bad url/sort/date', () => {
    const fd = fdOf({ title_en: ' ', title_zh: '', url: 'javascript:alert(1)', sort: 'abc', starts_at: '2026-13-40' });
    const r = parseAnnouncementForm(fd);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.title).toBe('errors.required');
    expect(r.errors.url).toBe('errors.urlInvalid');
    expect(r.errors.sort).toBe('errors.integerInvalid');
    expect(r.errors.starts_at).toBe('errors.dateFormat');
  });
});

describe('parseEventForm', () => {
  it('collects per-locale title + blurb, passes hidden image_key through, checks the checkbox', () => {
    const fd = fdOf({
      title_en: 'Retreat', title_zh: '教會退修會', blurb_en: 'A weekend away', blurb_zh: '週末退修',
      url: 'https://church.example/r', sort: '2', active: 'on', image_key: 'uploads/abc-flyer.png',
    });
    const r = parseEventForm(fd);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual({
      titles: { en: 'Retreat', zh: '教會退修會' },
      blurbs: { en: 'A weekend away', zh: '週末退修' },
      imageKey: 'uploads/abc-flyer.png', url: 'https://church.example/r', sort: 2, active: true, startsAt: null, endsAt: null,
    });
  });
  it('keeps a blurb only for a locale that also has a title', () => {
    const r = parseEventForm(fdOf({ title_en: 'Retreat', title_zh: '', blurb_en: '', blurb_zh: '沒有標題的簡介' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.titles).toEqual({ en: 'Retreat' });
    expect(r.data.blurbs).toEqual({}); // zh blurb dropped (no zh title); en blurb blank
  });
  it('requires at least one locale title', () => {
    const r = parseEventForm(fdOf({ title_en: '', title_zh: '' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.title).toBe('errors.required');
  });
});

describe('parsePersonForm', () => {
  it('parses a full person, lowercasing the email', () => {
    const r = parsePersonForm(fdOf({
      first_name: '長隆', last_name: '王', display_name: '王長隆', email: '  Wang@Example.COM ',
      phone: ' 214-555-0100 ', role: 'editor', active: 'on', lang: 'zh',
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual({
      firstName: '長隆', lastName: '王', displayName: '王長隆', email: 'wang@example.com',
      phone: '214-555-0100', role: 'editor', active: true, lang: 'zh',
    });
  });
  it('defaults empty optionals to null / inactive / member', () => {
    const r = parsePersonForm(fdOf({ display_name: '訪客', email: 'guest@example.com', role: 'member' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual({
      firstName: '', lastName: '', displayName: '訪客', email: 'guest@example.com',
      phone: null, role: 'member', active: false, lang: null,
    });
  });
  it('requires display_name and a valid email', () => {
    const r = parsePersonForm(fdOf({ display_name: '  ', email: 'not-an-email', role: 'member' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.display_name).toBe('errors.required');
    expect(r.errors.email).toBe('errors.emailInvalid');
  });
  it('flags an empty email as required and rejects bad role/lang enums', () => {
    const r = parsePersonForm(fdOf({ display_name: 'X', email: '', role: 'superuser', lang: 'fr' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.email).toBe('errors.required');
    expect(r.errors.role).toBe('errors.invalidOption');
    expect(r.errors.lang).toBe('errors.invalidOption');
  });
});

describe('parseSettingsForm', () => {
  it('reads only allowlisted keys present in the form', () => {
    const r = parseSettingsForm(fdOf({
      'site.name.en': 'Church4Christ', 'site.name.zh': '四方基督教会',
      'site.email': 'hi@church.example', 'site.giving_url': 'https://give.example',
      'theme.name': 'harvest', 'theme.default_mode': 'dark', 'locale.default': 'zh',
      'not.allowlisted': 'ignored',
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual({
      'site.name.en': 'Church4Christ', 'site.name.zh': '四方基督教会',
      'site.email': 'hi@church.example', 'site.giving_url': 'https://give.example',
      'theme.name': 'harvest', 'theme.default_mode': 'dark', 'locale.default': 'zh',
    });
    expect('not.allowlisted' in r.data).toBe(false);
  });
  it('validates url, email, and enum keys', () => {
    const r = parseSettingsForm(fdOf({
      'site.giving_url': 'javascript:alert(1)', 'site.email': 'bad', 'theme.name': 'neon',
      'theme.default_mode': 'sepia', 'locale.default': 'fr',
    }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors['site.giving_url']).toBe('errors.urlInvalid');
    expect(r.errors['site.email']).toBe('errors.emailInvalid');
    expect(r.errors['theme.name']).toBe('errors.invalidOption');
    expect(r.errors['theme.default_mode']).toBe('errors.invalidOption');
    expect(r.errors['locale.default']).toBe('errors.invalidOption');
  });
  it('allows a blank url/email (clearing) but not a blank enum', () => {
    const ok = parseSettingsForm(fdOf({ 'site.giving_url': '', 'site.email': '' }));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.data).toEqual({ 'site.giving_url': '', 'site.email': '' });
    const bad = parseSettingsForm(fdOf({ 'theme.name': '' }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors['theme.name']).toBe('errors.invalidOption');
  });
});

describe('parseBlockoutForm', () => {
  it('accepts an all-day range; end date defaults to start', () => {
    const r = parseBlockoutForm(fdOf({ start_date: '2030-01-10', end_date: '2030-01-12' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toMatchObject({
      startDate: '2030-01-10', endDate: '2030-01-12',
      startTime: null, endTime: null, reason: null, repeat: 'none', count: 1,
    });
    const single = parseBlockoutForm(fdOf({ start_date: '2030-01-10' }));
    expect(single.ok && single.data.endDate).toBe('2030-01-10');
  });

  it('accepts a full valid time pair', () => {
    const r = parseBlockoutForm(fdOf({ start_date: '2030-01-10', start_time: '09:00', end_time: '11:30' }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toMatchObject({ startTime: '09:00', endTime: '11:30' });
  });

  it('rejects a half-filled, malformed, or inverted time pair with errors.timePair', () => {
    const cases: Record<string, string>[] = [
      { start_time: '09:00' }, // only start
      { end_time: '11:00' }, // only end
      { start_time: '9am', end_time: '11:00' }, // malformed
      { start_time: '11:00', end_time: '09:00' }, // inverted
      { start_time: '11:00', end_time: '11:00' }, // zero-length
    ];
    for (const times of cases) {
      const r = parseBlockoutForm(fdOf({ start_date: '2030-01-10', ...times }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.start_time).toBe('errors.timePair');
    }
  });

  it('rejects bad or inverted dates', () => {
    const cases: Record<string, string>[] = [
      { start_date: 'nope' },
      { start_date: '2030-02-30' },
      { start_date: '2030-01-10', end_date: '2030-01-09' },
    ];
    for (const dates of cases) {
      const r = parseBlockoutForm(fdOf(dates));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.start_date).toBe('errors.dateFormat');
    }
  });

  it('clamps the repeat count to 2..26 and defaults it to 4', () => {
    const at = (repeat: string, count: string) => {
      const r = parseBlockoutForm(fdOf({ start_date: '2030-01-10', repeat, count }));
      if (!r.ok) throw new Error('expected ok');
      return r.data;
    };
    expect(at('weekly', '6')).toMatchObject({ repeat: 'weekly', count: 6 });
    expect(at('biweekly', '1').count).toBe(2);
    expect(at('weekly', '99').count).toBe(26);
    expect(at('weekly', '').count).toBe(4);
    expect(at('weekly', 'abc').count).toBe(4);
    // 'none' (or unknown) repeat always means a single row.
    expect(at('none', '9')).toMatchObject({ repeat: 'none', count: 1 });
    expect(at('daily', '9')).toMatchObject({ repeat: 'none', count: 1 });
  });
});

describe('parseApplicationForm', () => {
  it('signed-out requires team, name, and a valid email', () => {
    const missing = parseApplicationForm(fdOf({}), false);
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.errors.team_id).toBe('errors.required');
      expect(missing.errors.name).toBe('errors.required');
      expect(missing.errors.email).toBe('errors.required');
    }
    const badEmail = parseApplicationForm(fdOf({ team_id: '3', name: 'A', email: 'nope' }), false);
    expect(badEmail.ok).toBe(false);
    if (!badEmail.ok) expect(badEmail.errors.email).toBe('errors.emailInvalid');

    const ok = parseApplicationForm(
      fdOf({ team_id: '3', name: 'A B', email: 'A@Example.com', phone: ' 555 ', message: ' hi ', position_id: '7' }),
      false,
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.data).toEqual({
        teamId: 3, positionId: 7, name: 'A B', email: 'a@example.com', phone: '555', message: 'hi',
      });
    }
  });

  it('signed-in requires only the team; a non-numeric position becomes null', () => {
    const r = parseApplicationForm(fdOf({ team_id: '2', position_id: 'x' }), true);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toMatchObject({ teamId: 2, positionId: null, name: '', email: '' });
    expect(parseApplicationForm(fdOf({}), true).ok).toBe(false);
  });
});
