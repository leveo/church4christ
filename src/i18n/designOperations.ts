import type { Locale } from '../lib/locales';
const en = {
  settings: 'Shape your church website', settingsIntro: 'Manage your identity, visual style, contact details, and enabled features.',
  navigation: 'A clear path through your site', navigationIntro: 'Arrange the menu, add destinations, and review both languages.',
  learning: 'Learning administration', learningIntro: 'Connect a classroom, choose its courses, and keep the member catalog up to date.',
  campuses: 'One church, many places', insights: 'Participation & care', readiness: 'Launch readiness',
  readinessPassed: 'Checks passed', readinessAction: 'Action required', readinessManual: 'Manual review',
  appearanceDefault: 'Bundled artwork appears automatically when a custom image has not been uploaded.',
  connections: 'Connections', courses: 'Courses', addProvider: 'Add a classroom', inactive: 'Inactive',
  reportWindow: 'Reporting window (months)', apply: 'Apply', ministryCreated: 'Your ministry is ready', missingName: 'English name not provided',
};
const zh: typeof en = {
  settings: '打造你们的教会网站', settingsIntro: '设置教会资料、视觉风格、联系方式及启用的功能。',
  navigation: '清晰的浏览路径', navigationIntro: '排列菜单、添加页面，并检查中英文呈现。',
  learning: '课程管理', learningIntro: '连接课堂，选择课程，让会友课程目录保持更新。',
  campuses: '一间教会，多个堂点', insights: '参与与关怀', readiness: '上线准备',
  readinessPassed: '检查通过', readinessAction: '需要处理', readinessManual: '人工检查',
  appearanceDefault: '尚未上传自定义图片时，页面会自动使用随安装包提供的图片。',
  connections: '课堂连接', courses: '课程', addProvider: '添加课堂', inactive: '未启用',
  reportWindow: '统计时段（月）', apply: '应用', ministryCreated: '事工已就绪', missingName: '未填写名称',
};
export const operationsCopy = (locale: Locale) => locale === 'zh' ? zh : en;
