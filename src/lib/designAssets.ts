/** Decorative product imagery ships independently of fictional demo records.
 * Uploaded photographs always take precedence. Keep URLs same-origin for private Learning. */
export const DESIGN_IMAGES = {
  welcome: '/images/design/welcome.webp',
  sermons: '/images/design/sermon-bible.webp',
  learning: '/images/design/learning-creation.webp',
  groups: '/images/design/community.webp',
  family: '/images/design/family.webp',
  children: '/images/design/children.webp',
  worship: '/images/design/worship.webp',
  events: '/images/design/gathering.webp',
  kiosk: '/images/design/kiosk-garden.webp',
} as const;
export type DesignImage = keyof typeof DESIGN_IMAGES;
