// Block → class/style maps, the ONE source both renderers share (the Astro
// public renderer in src/components/blocks and the React canvas in
// src/components/builder), so editor preview and published page cannot drift.
// Every class literal is written out statically: Tailwind 4's scanner keeps a
// utility because it appears HERE — this module IS the safelist. Token
// utilities only (tokens:check); the sole arbitrary user value, a custom
// heading size, exits through an inline style object per the design spec.
import type {
  SectionNode, ColumnsNode, HeadingNode, TextNode, ImageNode, ButtonNode, SpacerNode,
} from './pageLayout';

type Align = 'left' | 'center' | 'right';
const TEXT_ALIGN: Record<Align, string> = { left: 'text-left', center: 'text-center', right: 'text-right' };
const FLEX_ALIGN: Record<Align, string> = { left: 'justify-start', center: 'justify-center', right: 'justify-end' };

const SECTION_BG: Record<SectionNode['props']['bg'], string> = {
  none: '',
  soft: 'bg-surface-sunken',
  primary: 'bg-primary-soft text-on-primary-soft',
  accent: 'bg-accent-soft text-on-accent-soft',
};
const SECTION_PAD: Record<SectionNode['props']['padY'], string> = { sm: 'py-6', md: 'py-10', lg: 'py-16' };
const SECTION_WIDTH: Record<SectionNode['props']['width'], string> = {
  narrow: 'container-narrow', content: 'container-content', wide: 'container-wide',
};

export function sectionOuterClass(props: SectionNode['props']): string {
  return SECTION_BG[props.bg];
}
export function sectionInnerClass(props: SectionNode['props']): string {
  return `${SECTION_WIDTH[props.width]} ${SECTION_PAD[props.padY]}`;
}

const COLUMNS_COUNT: Record<ColumnsNode['props']['count'], string> = {
  2: 'sm:grid-cols-2', 3: 'sm:grid-cols-3', 4: 'sm:grid-cols-2 lg:grid-cols-4',
};
const COLUMNS_GAP: Record<ColumnsNode['props']['gap'], string> = { sm: 'gap-4', md: 'gap-6', lg: 'gap-10' };

export function columnsClass(props: ColumnsNode['props']): string {
  return `grid ${COLUMNS_COUNT[props.count]} ${COLUMNS_GAP[props.gap]}`;
}

const HEADING_SIZE: Record<HeadingNode['props']['size'], string> = {
  sm: 'text-heading-sm', md: 'text-heading-md', lg: 'text-display-lg', xl: 'text-display-xl',
};

export function headingRender(props: HeadingNode['props']): { className: string; style?: { fontSize: string } } {
  const className = `font-display font-bold break-words ${HEADING_SIZE[props.size]} ${TEXT_ALIGN[props.align]}`;
  return props.customSizePx ? { className, style: { fontSize: `${props.customSizePx}px` } } : { className };
}

export function textClass(props: TextNode['props']): string {
  return `prose ${TEXT_ALIGN[props.align]}`;
}

const IMAGE_WIDTH: Record<ImageNode['props']['width'], string> = {
  full: 'w-full', wide: 'w-full max-w-3xl', medium: 'w-full max-w-xl', small: 'w-full max-w-sm',
};

export function imageRender(props: ImageNode['props']): { wrapperClass: string; imgClass: string } {
  return {
    wrapperClass: `flex ${FLEX_ALIGN[props.align]}`,
    imgClass: `${IMAGE_WIDTH[props.width]} h-auto${props.rounded ? ' rounded-xl' : ''}`,
  };
}

const BUTTON_VARIANT: Record<ButtonNode['props']['variant'], string> = {
  // Mirrors the public CTA idiom (see PrayerForm.astro's submit button).
  primary: 'bg-primary text-on-primary hover:bg-primary-hover',
  secondary: 'border border-border-strong text-ink hover:bg-surface-sunken',
};

export function buttonRender(props: ButtonNode['props']): { wrapperClass: string; linkClass: string } {
  return {
    wrapperClass: `flex ${FLEX_ALIGN[props.align]}`,
    linkClass: `inline-block rounded-full px-8 py-3 font-semibold no-underline ${BUTTON_VARIANT[props.variant]}`,
  };
}

const SPACER_SIZE: Record<SpacerNode['props']['size'], string> = { sm: 'h-4', md: 'h-8', lg: 'h-16', xl: 'h-24' };
export function spacerClass(props: SpacerNode['props']): string {
  return SPACER_SIZE[props.size];
}

export function dividerClass(): string {
  return 'border-t border-border';
}
