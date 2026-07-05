// English (default locale) UI strings. Flat keys, append-only as later slices
// add surfaces. Keep parity with zh.ts — the i18n test enforces identical key
// and {placeholder} sets across locales.
export default {
  'site.name': 'Church4Christ',
  'site.tagline': 'A church for the city',

  'nav.visit': 'Plan a Visit',
  'nav.about': 'About',
  'nav.sermons': 'Sermons',
  'nav.bulletin': 'Bulletin',
  'nav.events': 'Events',
  'nav.ministries': 'Ministries',
  'nav.serve': 'Serve',
  'nav.give': 'Give',
  'nav.articles': 'Articles',
  'nav.fellowships': 'Fellowships',
  'nav.prayer': 'Prayer',

  'footer.address': 'Address',
  'footer.contact': 'Contact',
  'footer.serviceTimes': 'Service Times',
  'footer.quickLinks': 'Quick Links',
  'footer.rights': 'All rights reserved.',
  'footer.modeToggle': 'Toggle theme',

  'common.readMore': 'Read more',
  'common.backTo': 'Back to',
  'common.language': 'Language',
  'common.menu': 'Menu',
  'common.signIn': 'Sign in',
  'common.signOut': 'Sign out',
  'common.mySchedule': 'My Schedule',

  'home.heroTitle': 'Find your place in God’s family',
  'home.heroSubtitle': 'Wherever you are on your journey of faith, there is a place for you here.',
  'home.welcome': 'Welcome to our church family',
  'home.upcomingEvents': 'Upcoming Events',
  'home.latestSermon': 'Latest Sermon',
  'home.ministriesTitle': 'Ways to get involved',
} satisfies Record<string, string>;
