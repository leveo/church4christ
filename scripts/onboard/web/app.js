'use strict';

// This wizard runs before the application exists, so it owns a small, paired dictionary.
const messages = {
  en: {
    skip: 'Skip to setup', localBadge: 'Local setup', uiLanguage: 'Wizard language', pageTitle: 'Welcome · Church4Christ', stepNavigation: 'Setup steps',
    eyebrow: 'A place for your community', heading: 'Make it your own.',
    intro: 'Start with your people, your identity, and the tools you need first. We’ll keep your choices on this computer for the setup that follows.',
    privacy: 'Your preferences stay in this repository’s local .church folder. You can revisit them anytime.',
    loading: 'Getting your workspace ready…', pageFooter: 'Built to serve churches, nonprofits, and campuses.',
    existingNote: 'This repository already has an installation. Saving updates your local preferences only. Follow docs/upgrade.md before applying changes.',
    back: 'Back', continue: 'Continue', save: 'Save preferences', saving: 'Saving…', footerHint: 'You can change these choices later.',
    steps: ['Your community', 'Your identity', 'Your features', 'Ready to begin'], stepCount: 'Step {step} of 4',
    stepTitles: ['Tell us about your community.', 'A familiar look, from day one.', 'Start with what you need.', 'Your first chapter starts here.'],
    stepDescriptions: [
      'A few details help us shape a home for your organization.',
      'Choose your colors and add a logo. See your identity come together below.',
      'We’ve selected a practical starting set using Cloudflare D1. Keep what serves your community; add more when you’re ready.',
      'Review your choices and choose your first administrator. Save them locally, then continue with the guided installer.',
    ],
    organizationType: 'What kind of community are you?', church: 'Church', nonprofit: 'Nonprofit', campus: 'Campus',
    name: 'Organization name', namePlaceholder: 'Grace Community', tagline: 'Tagline (optional)', taglinePlaceholder: 'A place to belong and grow',
    address: 'Address (optional)', addressPlaceholder: 'Street, city, region', timezone: 'Planning time zone',
    timezoneHint: 'Saved for your coding assistant to configure scheduling. Use an IANA time zone, such as America/Chicago or Asia/Shanghai.', timezoneInvalid: 'Enter a valid IANA time zone, such as America/Chicago.',
    siteSlug: 'Site identifier', slugHint: 'Lowercase letters, numbers, and hyphens. Used for local setup and deployment names.',
    locale: 'Default site language', languageEn: 'English', languageZh: '中文',
    primaryColor: 'Primary color', secondaryColor: 'Secondary color', colorPicker: '{label} picker',
    primaryHint: 'Your main brand color for links and actions.', secondaryHint: 'A supporting color for accents and details.',
    logo: 'Organization logo (optional)', logoHint: 'PNG, JPEG, or WebP · up to 2 MiB. Choose a file from your computer.',
    removeLogo: 'Remove logo', logoInvalid: 'Choose a PNG, JPEG, or WebP image no larger than 2 MiB.',
    logoReadError: 'This image could not be read. Choose a different image.', logoLoading: 'Your logo is still loading. Please wait a moment.', logoLoadError: 'Your saved logo could not be previewed. It will be kept unless you replace or remove it.',
    preview: 'A small preview of your identity', previewName: 'Your community', previewTagline: 'A place to belong.', previewAction: 'Welcome in', previewLogo: 'Organization logo preview',
    recommendedTitle: 'Recommended: Cloudflare D1',
    recommendedCopy: 'The Website + Community starter keeps your first database on Cloudflare D1. Hosting and media use Cloudflare Workers and R2; optional email and integrations can be configured later.',
    resetFeatures: 'Restore recommended features', selectedCount: '{count} selected',
    groups: { content: 'Website & publishing', community: 'People & community', volunteering: 'Volunteering & service' },
    dependencies: 'Requires: {names}', dependencyAdded: 'Required features added: {names}.', dependencyInUse: 'Also selected by: {names}. Deselect those features first to remove this one.',
    advanced: 'Advanced: PostgreSQL features', advancedCopy: 'These features need Supabase-compatible PostgreSQL and additional setup. They are optional and excluded from the recommended D1 starter.',
    postgresWarning: 'Your selection needs PostgreSQL. Save your preferences, then supply database and deployment details when continuing setup. A D1-only installation cannot enable these features.',
    emptyModules: 'Choose at least one feature for your initial setup.',
    reviewOrganization: 'Community', reviewDatabase: 'Database', reviewColors: 'Brand colors', reviewFeatures: 'Features', reviewLanguage: 'Site language',
    adminTitle: 'Your first administrator', adminName: 'Administrator name', adminNamePlaceholder: 'Alex Morgan', adminEmail: 'Administrator email',
    adminEmailHint: 'Use the address you want to sign in with. Local sign-in links are printed in the terminal.',
    demoTitle: 'Include fictional demo content', demoHint: 'Recommended for a first look. Explore example content and workflows. Turn this off to begin with empty content.',
    saveNotice: 'Saving writes your local preferences and logo. The installer will use these choices to configure your site.',
    successTitle: 'Your preferences are ready.', successDescription: 'Saved to {path}. Future setup and coding assistants can use these choices.',
    successEyebrow: 'A good beginning', previewCommand: '1. Preview the setup plan', applyCommand: '2. Run the local installer',
    stopReminder: 'When you’re done here, return to the terminal and press Ctrl+C to stop this wizard. Run the following commands from the repository root.',
    stopExisting: 'When you’re done here, return to the terminal and press Ctrl+C to stop this wizard.',
    existingSuccess: 'Your current installation has been preserved. Follow docs/upgrade.md to review and apply changes for an established installation.',
    postgresSuccess: 'These preferences require PostgreSQL. Follow docs/supabase-setup.md and supply the required database inputs before applying setup.',
    editPreferences: 'Edit preferences', successDependencies: 'Required features included: {names}.',
    tokenMissing: 'Open the complete URL printed by npm run onboard, including the part after #. This page needs that local session key.',
    loadError: 'Could not connect to the local wizard. Keep npm run onboard running, then reload its printed URL.',
    requestError: 'The request failed. Please try again.', savedStatus: 'Preferences saved.', logoStatus: 'Logo selected.',
  },
  zh: {
    skip: '跳转到配置', localBadge: '本地配置', uiLanguage: '向导语言', pageTitle: '欢迎 · Church4Christ', stepNavigation: '配置步骤',
    eyebrow: '为你的社群打造一个家', heading: '从这里，成为你的。',
    intro: '从你的社群、品牌与第一批需要的功能开始。我们会将你的选择保存在这台电脑上，供后续安装使用。',
    privacy: '偏好仅保存在本仓库的本地 .church 文件夹内。你可以随时回来修改。',
    loading: '正在准备你的工作区…', pageFooter: '为教会、非营利组织与校园社群而建。',
    existingNote: '此仓库已有安装。保存只会更新本地偏好。应用变更前，请按照 docs/upgrade.md 操作。',
    back: '上一步', continue: '继续', save: '保存偏好', saving: '正在保存…', footerHint: '这些选择以后都可以修改。',
    steps: ['你的社群', '品牌形象', '首批功能', '准备开始'], stepCount: '第 {step} 步，共 4 步',
    stepTitles: ['先认识一下你的社群。', '从第一天，就有熟悉的模样。', '从你需要的功能开始。', '新的一章，从这里开始。'],
    stepDescriptions: [
      '告诉我们一些基本信息，为你的组织打造合适的家。',
      '选择品牌颜色，上传标志。在下方预览你的品牌形象。',
      '我们已选好使用 Cloudflare D1 的起步功能。保留适合社群的功能，其他功能可以日后再添加。',
      '确认你的选择，并设置第一位管理员。保存本地偏好后，继续运行安装向导。',
    ],
    organizationType: '你的社群属于哪一类？', church: '教会', nonprofit: '非营利', campus: '校园',
    name: '组织名称', namePlaceholder: '恩典社区', tagline: '标语（选填）', taglinePlaceholder: '一同归属，一同成长',
    address: '地址（选填）', addressPlaceholder: '街道、城市、地区', timezone: '计划使用的时区',
    timezoneHint: '保存后供编程助手配置日程。使用 IANA 时区，例如 America/Chicago 或 Asia/Shanghai。', timezoneInvalid: '请输入有效的 IANA 时区，例如 Asia/Shanghai。',
    siteSlug: '站点标识', slugHint: '使用小写英文字母、数字与连字符，供本地安装与部署命名使用。',
    locale: '网站默认语言', languageEn: 'English', languageZh: '中文',
    primaryColor: '主色调', secondaryColor: '辅色调', colorPicker: '{label}选择器',
    primaryHint: '用于链接与操作按钮的主要品牌颜色。', secondaryHint: '用于装饰与细节的辅助颜色。',
    logo: '组织标志（选填）', logoHint: 'PNG、JPEG 或 WebP · 最大 2 MiB。请选择电脑上的图片。',
    removeLogo: '移除标志', logoInvalid: '请选择不大于 2 MiB 的 PNG、JPEG 或 WebP 图片。',
    logoReadError: '无法读取这张图片，请选择其他图片。', logoLoading: '标志仍在载入，请稍候。', logoLoadError: '暂时无法预览已保存的标志。除非替换或移除，否则原标志会保留。',
    preview: '你的品牌形象小预览', previewName: '你的社群', previewTagline: '一个让你有归属感的地方。', previewAction: '欢迎来到这里', previewLogo: '组织标志预览',
    recommendedTitle: '推荐：Cloudflare D1',
    recommendedCopy: '「网站 + 社群管理」起步组合使用 Cloudflare D1 数据库。网站与媒体使用 Cloudflare Workers 和 R2；邮件与其他集成可以日后配置。',
    resetFeatures: '恢复推荐功能', selectedCount: '已选择 {count} 项',
    groups: { content: '网站与内容发布', community: '成员与社群', volunteering: '志愿与服事' },
    dependencies: '需要：{names}', dependencyAdded: '已加入必需功能：{names}。', dependencyInUse: '以下已选功能需要它：{names}。请先取消这些功能。',
    advanced: '进阶：PostgreSQL 功能', advancedCopy: '这些功能需要兼容 Supabase 的 PostgreSQL 与额外配置。它们属于可选功能，不包含在推荐的 D1 起步组合中。',
    postgresWarning: '你的选择需要 PostgreSQL。请先保存偏好，再在后续安装中提供数据库与部署信息。仅使用 D1 的安装无法启用这些功能。',
    emptyModules: '请至少选择一项起步功能。',
    reviewOrganization: '社群', reviewDatabase: '数据库', reviewColors: '品牌颜色', reviewFeatures: '功能', reviewLanguage: '网站语言',
    adminTitle: '你的第一位管理员', adminName: '管理员姓名', adminNamePlaceholder: '王小明', adminEmail: '管理员邮箱',
    adminEmailHint: '使用你希望用于登录的邮箱。本地登录链接会输出到终端。',
    demoTitle: '包含虚构演示内容', demoHint: '推荐初次体验时启用，方便浏览示例内容与流程。取消勾选即可从空白内容开始。',
    saveNotice: '保存会写入本地偏好与标志。安装器将使用这些选择配置你的网站。',
    successTitle: '你的偏好已准备好。', successDescription: '已保存到 {path}。之后的安装与编程助手可以使用这些选择。',
    successEyebrow: '一个好的开始', previewCommand: '1. 预览安装计划', applyCommand: '2. 运行本地安装器',
    stopReminder: '完成后，请回到终端按 Ctrl+C 停止此向导。在仓库根目录运行以下命令。',
    stopExisting: '完成后，请回到终端按 Ctrl+C 停止此向导。',
    existingSuccess: '现有安装已保留。请按照 docs/upgrade.md 审核并应用已有安装的变更。',
    postgresSuccess: '这些偏好需要 PostgreSQL。请阅读 docs/supabase-setup.md，并在应用安装前提供必需的数据库信息。',
    editPreferences: '修改偏好', successDependencies: '已包含必需功能：{names}。',
    tokenMissing: '请打开 npm run onboard 输出的完整网址，包括 # 后面的部分。此页面需要该本地会话密钥。',
    loadError: '无法连接本地向导。请保持 npm run onboard 运行，然后重新打开其输出的网址。',
    requestError: '请求失败，请重试。', savedStatus: '偏好已保存。', logoStatus: '已选择标志。',
  },
};

const $ = (id) => document.getElementById(id);
const fragment = new URLSearchParams(window.location.hash.slice(1));
const token = fragment.get('token') || window.location.hash.slice(1);
let language = navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
let state;
let draft;
let step = 0;
let visited = 0;
let logoUpload;
let logoUrl;
let logoReading = false;
let logoReadVersion = 0;
let saving = false;
let savedResult;

function t(key, values = {}) {
  const value = messages[language][key];
  return typeof value === 'string'
    ? value.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''))
    : value;
}

function el(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function translateShell() {
  document.documentElement.lang = language;
  document.title = t('pageTitle');
  $('ui-language').value = language;
  document.querySelectorAll('[data-i18n]').forEach((element) => {
    element.textContent = t(element.dataset.i18n);
  });
  $('step-nav').setAttribute('aria-label', t('stepNavigation'));
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
    cache: 'no-store',
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || t('requestError'));
  }
  return response;
}

function showError(message) {
  $('error').textContent = message;
  $('error').hidden = false;
  $('error').focus();
}

function clearError() {
  $('error').hidden = true;
  $('error').textContent = '';
}

function featureName(key) {
  const labels = state.catalog.capabilities[key]?.labels;
  return labels?.[language] || labels?.en || key;
}

function postgresRequired() {
  return draft.setup.modules.some((key) => state.catalog.capabilities[key]?.requiresBackend === 'supabase');
}

function renderSteps() {
  $('steps').replaceChildren(...t('steps').map((label, index) => {
    const item = el('li');
    const button = el('button', `step-button${index < step || savedResult ? ' completed' : ''}`);
    button.type = 'button';
    button.disabled = index > visited || saving;
    if (index === step && !savedResult) button.setAttribute('aria-current', 'step');
    const number = el('span', 'step-number', index < step || savedResult ? '✓' : index + 1);
    number.setAttribute('aria-hidden', 'true');
    button.append(number, el('span', '', label));
    button.addEventListener('click', () => {
      if (index > step && !validateStep()) return;
      savedResult = undefined;
      step = index;
      clearError();
      render();
    });
    item.append(button);
    return item;
  }));
}

function field({ key, label, value, onInput, type = 'text', required = false, hint, placeholder, maxLength, pattern, wide = false, options, autocomplete }) {
  const wrapper = el('div', `field${wide ? ' field-wide' : ''}`);
  const labelElement = el('label', '', t(label));
  labelElement.htmlFor = key;
  const input = el(options ? 'select' : type === 'textarea' ? 'textarea' : 'input');
  if (!options && type !== 'textarea') input.type = type;
  input.id = key;
  input.name = key;
  input.required = required;
  if (options) options.forEach(([optionValue, optionLabel]) => {
    const option = el('option', '', optionLabel);
    option.value = optionValue;
    input.append(option);
  });
  input.value = value || '';
  if (placeholder) input.placeholder = t(placeholder);
  if (maxLength) input.maxLength = maxLength;
  if (pattern) input.pattern = pattern;
  if (autocomplete) input.autocomplete = autocomplete;
  input.addEventListener('input', () => {
    input.setCustomValidity('');
    onInput(input.value, input);
  });
  wrapper.append(labelElement, input);
  if (hint) {
    const help = el('p', 'field-hint', t(hint));
    help.id = `${key}-hint`;
    input.setAttribute('aria-describedby', help.id);
    wrapper.append(help);
  }
  return wrapper;
}

function renderIdentity() {
  const content = $('step-content');
  const types = el('fieldset');
  types.append(el('legend', '', t('organizationType')));
  const options = el('div', 'type-options');
  ['church', 'nonprofit', 'campus'].forEach((type) => {
    const label = el('label', 'type-card');
    const input = el('input');
    input.type = 'radio';
    input.name = 'organizationType';
    input.value = type;
    input.checked = draft.organization.type === type;
    input.addEventListener('change', () => { draft.organization.type = type; });
    label.append(input, el('span', '', t(type)));
    options.append(label);
  });
  types.append(options);
  const grid = el('div', 'field-grid');
  grid.append(
    field({ key: 'name', label: 'name', value: draft.organization.name, required: true, maxLength: 120, wide: true, placeholder: 'namePlaceholder', autocomplete: 'organization', onInput: (value) => { draft.organization.name = value; } }),
    field({ key: 'tagline', label: 'tagline', value: draft.organization.tagline, maxLength: 240, wide: true, placeholder: 'taglinePlaceholder', onInput: (value) => { draft.organization.tagline = value; } }),
    field({ key: 'address', label: 'address', value: draft.organization.address, maxLength: 500, wide: true, placeholder: 'addressPlaceholder', autocomplete: 'street-address', onInput: (value) => { draft.organization.address = value; } }),
    field({ key: 'timezone', label: 'timezone', value: draft.organization.timezone, required: true, maxLength: 100, hint: 'timezoneHint', onInput: (value) => { draft.organization.timezone = value; } }),
    field({ key: 'siteSlug', label: 'siteSlug', value: draft.setup.siteSlug, required: true, maxLength: 57, pattern: '[a-z0-9]+(-[a-z0-9]+)*', hint: 'slugHint', onInput: (value) => { draft.setup.siteSlug = value; } }),
    field({ key: 'locale', label: 'locale', value: draft.setup.locale, options: [['en', t('languageEn')], ['zh', t('languageZh')]], onInput: (value) => { draft.setup.locale = value; } }),
  );
  content.append(types, grid);
}

function colorField(key, label, hint) {
  const wrapper = el('div', 'field');
  const labelElement = el('label', '', t(label));
  labelElement.htmlFor = key;
  const controls = el('div', 'color-field');
  const picker = el('input');
  picker.type = 'color';
  picker.value = draft.branding[key];
  picker.setAttribute('aria-label', t('colorPicker', { label: t(label) }));
  const input = el('input');
  input.type = 'text';
  input.id = key;
  input.name = key;
  input.value = draft.branding[key];
  input.required = true;
  input.pattern = '#[0-9a-fA-F]{6}';
  input.maxLength = 7;
  input.spellcheck = false;
  const update = (value) => {
    if (/^#[0-9a-fA-F]{6}$/.test(value)) {
      draft.branding[key] = value.toUpperCase();
      picker.value = value;
      updatePreview();
    }
  };
  input.addEventListener('input', () => update(input.value));
  picker.addEventListener('input', () => { input.value = picker.value.toUpperCase(); update(picker.value); });
  const help = el('p', 'field-hint', t(hint));
  help.id = `${key}-hint`;
  input.setAttribute('aria-describedby', help.id);
  controls.append(picker, input);
  wrapper.append(labelElement, controls, help);
  return wrapper;
}

function replaceLogoUrl(url) {
  if (logoUrl?.startsWith('blob:')) URL.revokeObjectURL(logoUrl);
  logoUrl = url;
}

function renderBrand() {
  const grid = el('div', 'field-grid');
  grid.append(colorField('primaryColor', 'primaryColor', 'primaryHint'), colorField('secondaryColor', 'secondaryColor', 'secondaryHint'));
  const upload = el('div', 'field field-wide');
  const label = el('label', '', t('logo'));
  label.htmlFor = 'logo-upload';
  const box = el('div', 'upload-box');
  const input = el('input');
  input.type = 'file';
  input.id = 'logo-upload';
  input.accept = 'image/png,image/jpeg,image/webp';
  input.setAttribute('aria-describedby', 'logo-hint');
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    const version = ++logoReadVersion;
    logoReading = false;
    $('next').disabled = false;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 2 * 1024 * 1024) {
      input.value = '';
      showError(t('logoInvalid'));
      return;
    }
    logoReading = true;
    $('next').disabled = true;
    $('live-status').textContent = t('logoLoading');
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const image = new Image();
      image.src = dataUrl;
      await image.decode();
      if (version !== logoReadVersion) return;
      logoUpload = { name: file.name, dataUrl };
      replaceLogoUrl(dataUrl);
      clearError();
      updatePreview();
      if ($('remove-logo')) $('remove-logo').hidden = false;
      $('live-status').textContent = t('logoStatus');
    } catch {
      if (version !== logoReadVersion) return;
      input.value = '';
      showError(t('logoReadError'));
    } finally {
      if (version === logoReadVersion) {
        logoReading = false;
        $('next').disabled = saving;
      }
    }
  });
  const hint = el('p', 'field-hint', t('logoHint'));
  hint.id = 'logo-hint';
  const remove = el('button', 'text-button', t('removeLogo'));
  remove.id = 'remove-logo';
  remove.type = 'button';
  remove.hidden = !logoUrl && !draft.branding.logo;
  remove.addEventListener('click', () => {
    logoReadVersion += 1;
    logoReading = false;
    $('next').disabled = saving;
    logoUpload = undefined;
    draft.branding.logo = null;
    replaceLogoUrl(undefined);
    input.value = '';
    remove.hidden = true;
    updatePreview();
  });
  box.append(input, hint, remove);
  upload.append(label, box);
  grid.append(upload);
  const preview = el('div', 'brand-preview');
  preview.id = 'brand-preview';
  $('step-content').append(grid, preview);
  updatePreview();
}

function previewForeground(hex) {
  const components = hex.slice(1).match(/.{2}/g).map((part) => parseInt(part, 16) / 255);
  const linear = components.map((part) => part <= 0.04045 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4);
  const luminance = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  // Contrast extremes are calculated only for the user-selected brand preview.
  return luminance > 0.179 ? '#000000' : '#FFFFFF';
}

function updatePreview() {
  const preview = $('brand-preview');
  if (!preview) return;
  preview.style.setProperty('--preview-primary', draft.branding.primaryColor);
  preview.style.setProperty('--preview-secondary', draft.branding.secondaryColor);
  preview.style.setProperty('--preview-on-primary', previewForeground(draft.branding.primaryColor));
  const identity = el('div', 'preview-identity');
  if (logoUrl) {
    const image = el('img', 'preview-logo');
    image.src = logoUrl;
    image.alt = t('previewLogo');
    identity.append(image);
  } else {
    const symbol = el('span', 'preview-symbol', Array.from(draft.organization.name.trim() || 'c')[0].toUpperCase());
    symbol.setAttribute('aria-hidden', 'true');
    identity.append(symbol);
  }
  const text = el('div');
  text.append(el('p', 'preview-name', draft.organization.name || t('previewName')), el('p', 'preview-tagline', draft.organization.tagline || t('previewTagline')));
  identity.append(text);
  preview.replaceChildren(el('div', 'preview-accent'), el('p', 'preview-eyebrow', t('preview')), identity, el('span', 'preview-chip', t('previewAction')));
}

function addDependencies(selected) {
  const result = new Set(selected);
  function add(key) {
    for (const dependency of state.catalog.capabilities[key]?.dependsOn || []) {
      if (!result.has(dependency)) { result.add(dependency); add(dependency); }
    }
  }
  for (const key of selected) add(key);
  return state.catalog.order.filter((key) => result.has(key));
}

function dependentsOf(key) {
  return draft.setup.modules.filter((other) => other !== key && addDependencies([other]).includes(key));
}

function featureCard(key) {
  const feature = state.catalog.capabilities[key];
  const label = el('label', 'feature-card');
  const input = el('input');
  input.type = 'checkbox';
  input.name = 'modules';
  input.value = key;
  input.id = `module-${key}`;
  input.checked = draft.setup.modules.includes(key);
  const body = el('span');
  body.append(el('strong', '', featureName(key)), el('span', 'feature-description', feature.descriptions?.[language] || feature.descriptions?.en || ''));
  if (feature.dependsOn?.length) body.append(el('span', 'feature-dependencies', t('dependencies', { names: feature.dependsOn.map(featureName).join(', ') })));
  input.addEventListener('change', () => {
    clearError();
    const dependents = dependentsOf(key);
    if (!input.checked && dependents.length) {
      input.checked = true;
      showError(t('dependencyInUse', { names: dependents.map(featureName).join(', ') }));
      return;
    }
    const selected = new Set(draft.setup.modules);
    if (input.checked) selected.add(key); else selected.delete(key);
    draft.setup.modules = addDependencies([...selected]);
    const added = draft.setup.modules.filter((module) => !selected.has(module));
    document.querySelectorAll('input[name="modules"]').forEach((checkbox) => { checkbox.checked = draft.setup.modules.includes(checkbox.value); });
    $('feature-count').textContent = t('selectedCount', { count: draft.setup.modules.length });
    $('postgres-warning').hidden = !postgresRequired();
    if (added.length) $('live-status').textContent = t('dependencyAdded', { names: added.map(featureName).join(', ') });
  });
  label.append(input, body);
  return label;
}

function renderFeatures() {
  const content = $('step-content');
  const recommendation = el('div', 'notice recommendation');
  recommendation.append(el('strong', '', t('recommendedTitle')), el('p', 'field-hint', t('recommendedCopy')));
  const toolbar = el('div', 'feature-toolbar');
  const count = el('span', 'feature-count', t('selectedCount', { count: draft.setup.modules.length }));
  count.id = 'feature-count';
  count.setAttribute('aria-live', 'polite');
  const reset = el('button', 'text-button', t('resetFeatures'));
  reset.type = 'button';
  reset.addEventListener('click', () => {
    draft.setup.modules = addDependencies(state.catalog.presets['website-community'].modules);
    clearError();
    $('step-content').replaceChildren();
    renderFeatures();
  });
  toolbar.append(count, reset);
  content.append(recommendation, toolbar);
  for (const group of state.catalog.groups) {
    const keys = state.catalog.order.filter((key) => state.catalog.capabilities[key].group === group && state.catalog.capabilities[key].requiresBackend !== 'supabase');
    if (!keys.length) continue;
    const fieldset = el('fieldset');
    fieldset.append(el('legend', '', t('groups')[group] || group));
    const list = el('div', 'feature-list');
    keys.forEach((key) => list.append(featureCard(key)));
    fieldset.append(list);
    content.append(fieldset);
  }
  const advanced = el('details', 'advanced');
  advanced.open = postgresRequired();
  advanced.append(el('summary', '', t('advanced')), el('p', '', t('advancedCopy')));
  const advancedList = el('div', 'feature-list');
  state.catalog.order.filter((key) => state.catalog.capabilities[key].requiresBackend === 'supabase').forEach((key) => advancedList.append(featureCard(key)));
  advanced.append(advancedList);
  const warning = el('p', 'notice warning', t('postgresWarning'));
  warning.id = 'postgres-warning';
  warning.hidden = !postgresRequired();
  warning.setAttribute('role', 'status');
  content.append(advanced, warning);
}

function renderReview() {
  const summary = el('div', 'summary-box');
  const list = el('dl');
  const rows = [
    ['reviewOrganization', `${draft.organization.name} · ${t(draft.organization.type)}`],
    ['reviewDatabase', postgresRequired() ? 'Supabase PostgreSQL' : 'Cloudflare D1'],
    ['reviewLanguage', draft.setup.locale === 'zh' ? t('languageZh') : t('languageEn')],
    ['reviewFeatures', draft.setup.modules.map(featureName).join(' · ')],
  ];
  rows.forEach(([label, value]) => {
    const row = el('div', 'summary-row');
    row.append(el('dt', '', t(label)), el('dd', '', value));
    list.append(row);
  });
  const colorRow = el('div', 'summary-row');
  const colors = el('dd', 'summary-colors');
  for (const color of [draft.branding.primaryColor, draft.branding.secondaryColor]) {
    const swatch = el('span', 'swatch');
    swatch.style.backgroundColor = color;
    swatch.setAttribute('aria-hidden', 'true');
    colors.append(swatch, el('span', '', color));
  }
  colorRow.append(el('dt', '', t('reviewColors')), colors);
  list.append(colorRow);
  summary.append(list);
  $('step-content').append(summary);
  if (postgresRequired()) $('step-content').append(el('p', 'notice warning', t('postgresWarning')));
  const admin = el('fieldset');
  admin.append(el('legend', '', t('adminTitle')));
  const grid = el('div', 'field-grid');
  grid.append(
    field({ key: 'adminName', label: 'adminName', value: draft.setup.adminName, required: true, maxLength: 120, placeholder: 'adminNamePlaceholder', autocomplete: 'name', onInput: (value) => { draft.setup.adminName = value; } }),
    field({ key: 'adminEmail', label: 'adminEmail', value: draft.setup.adminEmail, type: 'email', required: true, maxLength: 254, hint: 'adminEmailHint', autocomplete: 'email', onInput: (value) => { draft.setup.adminEmail = value; } }),
  );
  admin.append(grid);
  const demo = el('label', 'demo-option');
  const checkbox = el('input');
  checkbox.type = 'checkbox';
  checkbox.name = 'demoData';
  checkbox.checked = draft.setup.demoData;
  checkbox.addEventListener('change', () => { draft.setup.demoData = checkbox.checked; });
  const text = el('span');
  text.append(el('strong', '', t('demoTitle')), el('span', 'field-hint', t('demoHint')));
  demo.append(checkbox, text);
  $('step-content').append(admin, demo, el('p', 'field-hint', t('saveNotice')));
}

function render() {
  translateShell();
  renderSteps();
  $('wizard').hidden = !!savedResult;
  $('success').hidden = !savedResult;
  if (savedResult) { renderSuccess(); return; }
  $('step-count').textContent = t('stepCount', { step: step + 1 });
  $('step-title').textContent = t('stepTitles')[step];
  $('step-description').textContent = t('stepDescriptions')[step];
  $('step-content').replaceChildren();
  [renderIdentity, renderBrand, renderFeatures, renderReview][step]();
  $('back').hidden = step === 0;
  $('next').textContent = t(saving ? 'saving' : step === 3 ? 'save' : 'continue');
  $('next').disabled = saving || logoReading;
  $('step-title').focus({ preventScroll: true });
}

function validateStep() {
  if (logoReading) { showError(t('logoLoading')); return false; }
  if (step === 0) {
    const timezone = $('timezone');
    try {
      new Intl.DateTimeFormat('en', { timeZone: timezone.value.trim() });
      timezone.setCustomValidity('');
    } catch { timezone.setCustomValidity(t('timezoneInvalid')); }
  }
  if (!$('wizard').reportValidity()) return false;
  if (step === 2 && !draft.setup.modules.length) { showError(t('emptyModules')); return false; }
  return true;
}

function renderSuccess() {
  const success = $('success');
  const mark = el('div', 'success-mark', '✓');
  mark.setAttribute('aria-hidden', 'true');
  const title = el('h2', '', t('successTitle'));
  title.id = 'success-title';
  title.tabIndex = -1;
  success.replaceChildren(mark, el('p', 'eyebrow', t('successEyebrow')), title,
    el('p', 'muted', t('successDescription', { path: savedResult.preferencesPath })));
  if (savedResult.addedDependencies?.length) success.append(el('p', 'notice', t('successDependencies', { names: savedResult.addedDependencies.map((entry) => featureName(entry.added)).join(', ') })));
  if (savedResult.existingInstallation) {
    success.append(el('p', 'notice recommendation', t('existingSuccess')), el('p', 'muted', t('stopExisting')));
  } else {
    if (savedResult.backend === 'supabase') success.append(el('p', 'notice warning', t('postgresSuccess')));
    success.append(el('p', 'muted', t('stopReminder')));
    for (const [key, command] of [['previewCommand', savedResult.commands.preview], ['applyCommand', savedResult.commands.apply]]) {
      if (command) success.append(el('p', 'command-label', t(key)), el('pre', 'command', command));
    }
  }
  const actions = el('div', 'success-actions');
  const edit = el('button', 'button secondary', t('editPreferences'));
  edit.type = 'button';
  edit.addEventListener('click', () => { savedResult = undefined; step = 0; render(); });
  actions.append(edit);
  success.append(actions);
  title.focus({ preventScroll: true });
}

// Preserve the fragment session key when using the keyboard skip link.
document.querySelector('.skip-link').addEventListener('click', (event) => {
  event.preventDefault();
  $('main').focus();
  $('main').scrollIntoView();
});

$('back').addEventListener('click', () => { step -= 1; clearError(); render(); });
$('ui-language').addEventListener('change', (event) => {
  language = event.target.value;
  if (state) render(); else translateShell();
});
$('wizard').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (saving || !validateStep()) return;
  clearError();
  if (step < 3) {
    step += 1;
    visited = Math.max(visited, step);
    render();
    return;
  }
  saving = true;
  $('next').textContent = t('saving');
  $('wizard').setAttribute('aria-busy', 'true');
  const controls = [...document.querySelectorAll('button, input, select, textarea')];
  const previouslyDisabled = new Set(controls.filter((control) => control.disabled));
  controls.forEach((control) => { control.disabled = true; });
  try {
    const response = await request('/api/preferences', { method: 'POST', body: JSON.stringify({ ...draft, ...(logoUpload ? { logoUpload } : {}) }) });
    savedResult = await response.json();
    draft = structuredClone(savedResult.preferences);
    logoUpload = undefined;
    $('live-status').textContent = t('savedStatus');
  } catch (error) {
    showError(error.message || t('requestError'));
  } finally {
    saving = false;
    $('wizard').removeAttribute('aria-busy');
    controls.forEach((control) => { control.disabled = previouslyDisabled.has(control); });
    if (savedResult) render();
    else $('next').textContent = t('save');
  }
});

async function initialize() {
  translateShell();
  if (!token) {
    $('loading').hidden = true;
    showError(t('tokenMissing'));
    return;
  }
  try {
    state = await (await request('/api/state')).json();
    draft = structuredClone(state.preferences || state.defaults);
    draft.setup.modules = addDependencies(draft.setup.modules);
    $('installation-note').hidden = !state.existingInstallation;
    if (draft.branding.logo) {
      try { replaceLogoUrl(URL.createObjectURL(await (await request('/api/logo')).blob())); }
      catch { showError(t('logoLoadError')); }
    }
    $('loading').hidden = true;
    render();
  } catch (error) {
    $('loading').hidden = true;
    showError(`${t('loadError')} ${error.message || ''}`);
  }
}

initialize();
