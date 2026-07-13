import { normalizeSetupAnswers } from './answers.mjs';

const prompt = async (ask, key, message, choices, extra = {}) => {
  const value = await ask(Object.freeze({ key, message, ...(choices ? { choices } : {}), ...extra }));
  if (value === undefined || value === null || value === '') throw new Error(`No answer was provided for ${key}`);
  return value;
};

const yes = (value) => value === true || value === 'yes' || value === 'y';
const no = (value) => value === false || value === 'no' || value === 'n';

export async function collectInteractiveAnswers(partial, catalog, ask) {
  if (!partial || typeof partial !== 'object' || Array.isArray(partial)) throw new TypeError('partial setup answers are required');
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) throw new TypeError('capability catalog is required');
  if (typeof ask !== 'function') throw new TypeError('interactive ask function is required');

  const answers = { ...partial };
  answers.mode ??= await prompt(ask, 'mode', 'Where should this church run?', [
    { value: 'local', label: 'Local trial' }, { value: 'deploy', label: 'Deploy to Cloudflare' },
  ]);

  if (!answers.preset && !answers.modules?.length) {
    const featureChoice = await prompt(ask, 'featureChoice', 'Which features should be enabled?', [
      { value: 'website', label: 'Website' },
      { value: 'website-community', label: 'Website + Community' },
      { value: 'full-church', label: 'Full Church' },
      { value: 'customize', label: 'Customize' },
    ]);
    if (featureChoice !== 'customize') {
      answers.preset = featureChoice;
    } else {
      let selected = [];
      for (const group of catalog.groups) {
        const modules = catalog.order.filter((key) => catalog.capabilities[key].group === group);
        const response = await prompt(
          ask,
          `group.${group}`,
          `Enable the ${group} capabilities?`,
          [{ value: true, label: 'Yes' }, { value: false, label: 'No' }],
          { modules: Object.freeze([...modules]) },
        );
        if (yes(response)) selected.push(...modules);
        else if (!no(response)) throw new Error(`The ${group} group answer must be yes or no`);
      }
      selected = catalog.order.filter((key) => selected.includes(key));
      while (true) {
        const review = await prompt(
          ask,
          'moduleReview',
          `Review exact modules: ${selected.join(', ') || '(none)'}`,
          [{ value: true, label: 'Use these modules' }, { value: false, label: 'Change selection' }, { value: 'cancel', label: 'Cancel setup' }],
          { modules: Object.freeze([...selected]) },
        );
        if (yes(review)) { answers.modules = selected; break; }
        if (review === 'cancel') throw new Error('Setup cancelled during custom module review');
        if (!no(review)) throw new Error('Custom module review must be accepted, changed, or cancelled');
        const correction = await prompt(
          ask,
          'moduleSelection',
          'Select the exact capabilities to enable',
          catalog.order.map((key) => ({ value: key, label: catalog.capabilities[key].labels.en })),
          { multiple: true, modules: Object.freeze([...catalog.order]) },
        );
        if (!Array.isArray(correction)) throw new Error('Exact module selection must be a list');
        const unknown = correction.filter((key) => !catalog.order.includes(key));
        if (unknown.length) throw new Error(`Unknown capabilities: ${unknown.join(', ')}`);
        selected = catalog.order.filter((key) => correction.includes(key));
      }
    }
  }

  answers.siteSlug ??= await prompt(ask, 'siteSlug', 'Site slug');
  answers.churchName ??= await prompt(ask, 'churchName', 'Church name');
  answers.locale ??= await prompt(ask, 'locale', 'Default language', [
    { value: 'en', label: 'English' }, { value: 'zh', label: 'Chinese' },
  ]);
  answers.adminName ??= await prompt(ask, 'adminName', 'First-admin display name');
  answers.adminEmail ??= await prompt(ask, 'adminEmail', 'First-admin email');
  if (answers.mode === 'deploy') {
    answers.appOrigin ??= await prompt(ask, 'appOrigin', 'Public HTTPS origin');
    answers.emailFrom ??= await prompt(ask, 'emailFrom', 'Verified sender email');
  }
  if (!answers.demoDataSpecified) {
    answers.demoData = yes(await prompt(ask, 'demoData', 'Load fictional demo data?', [
      { value: true, label: 'Yes' }, { value: false, label: 'No' },
    ]));
  }

  return normalizeSetupAnswers(answers, catalog);
}
