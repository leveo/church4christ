const isPresent = (value) => typeof value === 'string' ? value.trim().length > 0 : value != null;

export function missingAnswers(answers) {
  const missing = [];
  if (!isPresent(answers.mode)) missing.push('mode');
  if (!isPresent(answers.preset) && !(Array.isArray(answers.modules) && answers.modules.length > 0)) {
    missing.push('featureChoice');
  }
  for (const key of ['siteSlug', 'churchName', 'locale', 'adminEmail', 'adminName']) {
    if (!isPresent(answers[key])) missing.push(key);
  }
  if (answers.mode === 'deploy') {
    if (!isPresent(answers.appOrigin)) missing.push('appOrigin');
    if (!isPresent(answers.emailFrom)) missing.push('emailFrom');
  }
  return missing;
}
