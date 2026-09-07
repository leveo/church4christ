import { pickLocalizedText, type Locale } from './locales';

/** Display the unsaved wizard fields without changing or validating the submission. */
export function ministryWizardReview(form: FormData, locale: Locale) {
  const text = (key: string) => String(form.get(key) ?? '').trim();
  const list = (key: string) => form.getAll(key).map(value => String(value).trim());
  const english = list('pos_name_en');
  const chinese = list('pos_name_zh');
  const needed = list('pos_needed');
  const open = list('pos_open');
  return {
    name: pickLocalizedText({ en: text('name_en'), zh: text('name_zh') }, locale),
    meetingTime: text('meeting_time'),
    roles: english.flatMap((name, index) => !name && !chinese[index] ? [] : [{
      name: pickLocalizedText({ en: name, zh: chinese[index] ?? '' }, locale),
      needed: needed[index] ?? '1',
      open: open[index] === '1',
    }]),
  };
}
