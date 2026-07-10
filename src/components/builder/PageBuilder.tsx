// Page-builder island root. Tasks 8-9 replace this stub with the real canvas;
// the props contract here IS the server contract (see builder/[id].astro).
export interface PageBuilderProps {
  pageId: string | null;
  slug: string;
  published: boolean;
  titleEn: string;
  titleZh: string;
  layoutJson: string;
  media: { path: string; filename: string }[];
  strings: Record<string, string>;
  uiLang: 'en' | 'zh';
}

export default function PageBuilder(props: PageBuilderProps) {
  return <div data-testid="pb-root">{props.strings.title}</div>;
}
