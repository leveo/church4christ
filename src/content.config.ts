// Content collections for the public site. Each collection is a glob over
// src/content/<coll>/{en,zh}/<slug>.md, so an entry's `id` carries its locale
// folder (e.g. 'en/visit', 'zh/visit') — that folder is how src/lib/content.ts
// filters/falls back by locale. Schemas validate frontmatter at `astro check`.
import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

// Evergreen prose pages (visit, about, beliefs, privacy, give). Title/description
// drive the <title>/meta and the page title band; the body is the prose.
const pages = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/pages' }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
  }),
});

// Pastoral articles. `date` is a plain 'YYYY-MM-DD' string (chosen over Date so
// it sorts lexically and renders without timezone drift); excerpt feeds the
// listing cards.
const articles = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/articles' }),
  schema: z.object({
    title: z.string(),
    author: z.string(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
    excerpt: z.string().optional(),
  }),
});

// Small-group fellowships. `order` sorts the directory; `leaders` is a list of
// {name, role?} rendered on the card + detail page.
const fellowships = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/fellowships' }),
  schema: z.object({
    name: z.string(),
    meetingTime: z.string(),
    location: z.string(),
    audience: z.string().optional(),
    order: z.number(),
    leaders: z
      .array(
        z.object({
          name: z.string(),
          role: z.string().optional(),
        }),
      )
      .default([]),
  }),
});

// Team members. `group` buckets the staff index (pastoral / elders / staff);
// `order` sorts within a group. `avatar` is an optional local SVG path — when
// unset the UI falls back to AvatarInitials.
const staff = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/staff' }),
  schema: z.object({
    name: z.string(),
    role: z.string(),
    group: z.enum(['pastoral', 'elders', 'staff']),
    order: z.number(),
    email: z.string().optional(),
    avatar: z.string().optional(),
  }),
});

export const collections = { pages, articles, fellowships, staff };
