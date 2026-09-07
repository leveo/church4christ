import { describe, expect, it } from 'vitest';
import { ministryWizardReview } from '../src/lib/ministryWizardReview';

describe('ministry wizard review before publishing', () => {
  it('keeps repeated role requirements paired when empty rows are omitted', () => {
    const form = new FormData();
    form.set('name_en', 'Welcome team');
    form.set('meeting_time', 'Sunday 09:30');
    ['', 'Greeter', 'Host'].forEach(value => form.append('pos_name_en', value));
    ['', '', '接待'].forEach(value => form.append('pos_name_zh', value));
    ['1', '2', '3'].forEach(value => form.append('pos_needed', value));
    ['0', '1', '0'].forEach(value => form.append('pos_open', value));
    expect(ministryWizardReview(form, 'en')).toEqual({
      name: 'Welcome team', meetingTime: 'Sunday 09:30',
      roles: [{ name: 'Greeter', needed: '2', open: true }, { name: 'Host', needed: '3', open: false }],
    });
  });
  it('uses English fields on English review and Chinese with English fallback on Chinese review', () => {
    const form = new FormData();
    form.set('name_zh', '接待团队');
    form.append('pos_name_en', 'Host'); form.append('pos_name_zh', '');
    expect(ministryWizardReview(form, 'en').name).toBe('');
    expect(ministryWizardReview(form, 'zh').name).toBe('接待团队');
    expect(ministryWizardReview(form, 'zh').roles[0].name).toBe('Host');
  });
  it('preserves unsaved text as text and does not rewrite the submitted form', () => {
    const form = new FormData();
    form.set('name_en', '<strong>Hosts</strong>');
    form.append('pos_name_en', 'Sound');
    const before = [...form.entries()];
    expect(ministryWizardReview(form, 'en').name).toBe('<strong>Hosts</strong>');
    expect([...form.entries()]).toEqual(before);
  });
  it('retains a Chinese-only role that publishing will create, leaving its English label for the UI placeholder', () => {
    const form = new FormData();
    ['', ''].forEach(value => form.append('pos_name_en', value));
    ['', '接待'].forEach(value => form.append('pos_name_zh', value));
    ['1', '3'].forEach(value => form.append('pos_needed', value));
    ['0', '1'].forEach(value => form.append('pos_open', value));
    expect(ministryWizardReview(form, 'en').roles).toEqual([{ name: '', needed: '3', open: true }]);
  });
});
