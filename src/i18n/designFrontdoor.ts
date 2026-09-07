import type { Locale } from '../lib/locales';
const en = {
  about: 'Life together', beliefs: 'What we believe', visit: 'Your first Sunday',
  people: 'People & community', fellowships: 'Find your community', ministries: 'Serve with purpose',
  welcome: 'There is a place for you here.', welcomeBody: 'Tell us a little about yourself. We would love to help you take your next step.',
  connection: 'Connection card', contact: 'Stay connected', visitDetails: 'Plan your visit',
  giving: 'A shared commitment', givingBody: 'Support the life and ministry of your church.',
  giftDetails: 'Your gift', visitLink: 'Plan a visit', cardLink: 'Introduce yourself',
  readBio: 'Read biography', explore: 'Explore', signin: 'Welcome back', signup: 'Begin your journey',
  accountBody: 'Connect with your church, care for one another, and find your next step.',
};
const zh: typeof en = {
  about: '一起生活，一起成长', beliefs: '我们的信仰', visit: '第一次来到教会',
  people: '认识教会的家人', fellowships: '找到你的团契', ministries: '一起参与服事',
  welcome: '这里有属于你的位置。', welcomeBody: '让我们多认识你一点，一起找到适合你的下一步。',
  connection: '新人联系卡', contact: '保持联系', visitDetails: '来访指南',
  giving: '共同的托付', givingBody: '支持教会的生活与事工。',
  giftDetails: '奉献详情', visitLink: '计划来访', cardLink: '认识你',
  readBio: '阅读介绍', explore: '进一步了解', signin: '欢迎回来', signup: '开始你的旅程',
  accountBody: '与教会连接，彼此关怀，一起迈出下一步。',
};
export const frontdoorCopy = (locale: Locale) => locale === 'zh' ? zh : en;
