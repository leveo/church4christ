# Church glossary for translators

Translators and reviewers use this table so the same church term is rendered the same way
everywhere: dictionary, design copy, capability catalog, emails, and documentation. English
(`en`) is the source and Chinese (`zh`) is filled from the existing interface copy. **The
other ten columns are empty on purpose:** the translator for each language fills in its own
column first, before translating the dictionary, and a reviewer checks it. Translations are
AI-assisted, community review welcome.

How to use it:

1. Fill your language's column. Prefer the word a congregation in that language would say
   aloud, not a literal dictionary equivalent. Note the denomination or region you assumed
   (for example Catholic versus Protestant usage for *communion*) in the Notes column.
2. Translate `src/i18n/<code>.ts`, the design copy, and the catalog copy using these terms.
3. If a term needs two words depending on context (for example *giving* as a noun versus
   the action), add a second row instead of overloading one cell.
4. Keep this file in the same pull request as the language.

Run `node scripts/i18n/check.mjs --locale <code>` for the automated gates; the glossary is
a human check and is not machine-enforced.

## Terms

| Term (en) | 中文 (zh) | es | pt-BR | fr | de | ja | ko | ms | id | vi | hi | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Church & people** |  |  |  |  |  |  |  |  |  |  |  |  |
| pastor | 牧师 |  |  |  |  |  |  |  |  |  |  |  |
| elder | 长老 |  |  |  |  |  |  |  |  |  |  |  |
| deacon | 执事 |  |  |  |  |  |  |  |  |  |  |  |
| staff | 同工 |  |  |  |  |  |  |  |  |  |  |  |
| member | 正式会友 |  |  |  |  |  |  |  |  |  |  |  |
| newcomer | 新朋友 |  |  |  |  |  |  |  |  |  |  |  |
| household | 家庭 |  |  |  |  |  |  |  |  |  |  |  |
| child | 孩童 |  |  |  |  |  |  |  |  |  |  |  |
| guardian | 家长 |  |  |  |  |  |  |  |  |  |  |  |
| leader | 负责人 |  |  |  |  |  |  |  |  |  |  |  |
| volunteer | 义工 |  |  |  |  |  |  |  |  |  |  |  |
| campus | 堂点 |  |  |  |  |  |  |  |  |  |  |  |
| **Ministry & groups** |  |  |  |  |  |  |  |  |  |  |  |  |
| ministry | 事工 |  |  |  |  |  |  |  |  |  |  |  |
| serving team | 服事团队 |  |  |  |  |  |  |  |  |  |  |  |
| small group | 小组 |  |  |  |  |  |  |  |  |  |  |  |
| fellowship | 团契 |  |  |  |  |  |  |  |  |  |  |  |
| Sunday school | 主日学 |  |  |  |  |  |  |  |  |  |  |  |
| prayer wall | 祷告墙 |  |  |  |  |  |  |  |  |  |  |  |
| prayer request | 祷告事项 |  |  |  |  |  |  |  |  |  |  |  |
| prayer sheet | 祷告单 |  |  |  |  |  |  |  |  |  |  |  |
| testimony | 见证 |  |  |  |  |  |  |  |  |  |  |  |
| spiritual gift | 恩赐 |  |  |  |  |  |  |  |  |  |  |  |
| serving opportunity | 服事机会 |  |  |  |  |  |  |  |  |  |  |  |
| **Worship & content** |  |  |  |  |  |  |  |  |  |  |  |  |
| worship | 敬拜 |  |  |  |  |  |  |  |  |  |  |  |
| service (gathering) | 崇拜 |  |  |  |  |  |  |  |  |  |  |  |
| sermon | 讲道 |  |  |  |  |  |  |  |  |  |  |  |
| series | 系列 |  |  |  |  |  |  |  |  |  |  |  |
| scripture | 经文 |  |  |  |  |  |  |  |  |  |  |  |
| bulletin | 周报 |  |  |  |  |  |  |  |  |  |  |  |
| announcement | 消息 |  |  |  |  |  |  |  |  |  |  |  |
| article | 文章 |  |  |  |  |  |  |  |  |  |  |  |
| event | 活动 |  |  |  |  |  |  |  |  |  |  |  |
| **Sacraments** |  |  |  |  |  |  |  |  |  |  |  |  |
| baptism | 洗礼 |  |  |  |  |  |  |  |  |  |  |  |
| communion | 圣餐 |  |  |  |  |  |  |  |  |  |  |  |
| **Giving & finance** |  |  |  |  |  |  |  |  |  |  |  |  |
| offering | 奉献 |  |  |  |  |  |  |  |  |  |  |  |
| giving | 奉献 |  |  |  |  |  |  |  |  |  |  |  |
| tithe | 十一奉献 |  |  |  |  |  |  |  |  |  |  |  |
| fund | 奉献项目 |  |  |  |  |  |  |  |  |  |  |  |
| donor | 奉献人 |  |  |  |  |  |  |  |  |  |  |  |
| recurring gift | 定期奉献 |  |  |  |  |  |  |  |  |  |  |  |
| giving statement | 奉献报表 |  |  |  |  |  |  |  |  |  |  |  |
| receipt | 收据 |  |  |  |  |  |  |  |  |  |  |  |
| registration | 活动报名 |  |  |  |  |  |  |  |  |  |  |  |
| **Scheduling** |  |  |  |  |  |  |  |  |  |  |  |  |
| run sheet | 流程单 |  |  |  |  |  |  |  |  |  |  |  |
| rehearsal | 排练 |  |  |  |  |  |  |  |  |  |  |  |
| scheduling / roster | 服事排班 |  |  |  |  |  |  |  |  |  |  |  |
| availability | 可服事时间 |  |  |  |  |  |  |  |  |  |  |  |
| blockout date | 不能服事的日期 |  |  |  |  |  |  |  |  |  |  |  |
| assignment | 服事安排 |  |  |  |  |  |  |  |  |  |  |  |
| **Care & follow-up** |  |  |  |  |  |  |  |  |  |  |  |  |
| check-in | 签到 |  |  |  |  |  |  |  |  |  |  |  |
| kiosk | 签到台 |  |  |  |  |  |  |  |  |  |  |  |
| pickup code | 接送码 |  |  |  |  |  |  |  |  |  |  |  |
| attendance | 出席 |  |  |  |  |  |  |  |  |  |  |  |
| follow-up | 跟进 |  |  |  |  |  |  |  |  |  |  |  |
| care | 关怀 |  |  |  |  |  |  |  |  |  |  |  |
| connection card | 新人联系卡 |  |  |  |  |  |  |  |  |  |  |  |
| membership | 会籍 |  |  |  |  |  |  |  |  |  |  |  |
| **Product & account** |  |  |  |  |  |  |  |  |  |  |  |  |
| sign-in link | 登录链接 |  |  |  |  |  |  |  |  |  |  |  |
| administrator | 管理员 |  |  |  |  |  |  |  |  |  |  |  |
| editor | 编辑 |  |  |  |  |  |  |  |  |  |  |  |
| language | 语言 |  |  |  |  |  |  |  |  |  |  |  |
| theme | 主题 |  |  |  |  |  |  |  |  |  |  |  |
| backup | 备份 |  |  |  |  |  |  |  |  |  |  |  |
| learning (course) | 学习 |  |  |  |  |  |  |  |  |  |  |  |
| page builder | 页面编辑器 |  |  |  |  |  |  |  |  |  |  |  |

## Do not translate

Leave these exactly as written, in every language:

- **Product and brand names:** Church4Christ, Stripe, Cloudflare, Supabase, Google Classroom,
  Canvas, Planning Center.
- **Technical names and formats:** CSV, PDF, iCal, QR, URL, OK, API, D1, R2, Workers.
- **Placeholders:** `{name}`, `{count}`, and every other `{word}` token. Do not translate,
  rename, add, or drop them. They may move within the sentence.
- **HTML tags and entities** inside a value, such as `<b>…</b>`, `<a>…</a>`, `<br>`, `&amp;`.
  Keep the same tags; translate only the text between them.
- **URLs, email addresses, file names, route paths, and keyboard keys.**
- **Dictionary keys** (the left-hand side of `src/i18n/<code>.ts`) and any identifier in code.

Text that is legitimately identical to English in your language (a cognate such as "Contact")
goes in `config/i18n-allowlist.json` under `locales.<code>`, never as an untranslated copy.

