-- Church4Christ bilingual demo seed (Slice 2, Task 5).
-- Run ONCE after migrations on a FRESH local DB:
--   npm run db:migrate:local && npm run db:seed:local
-- All content is FICTIONAL. Every person address is @example.com and must never
-- be emailed. The only real-looking value is the demo contact address in the
-- settings block (hello@church.yunfei-song.com), which is the spec demo domain.
--
-- RELATIVE DATES — every time-sensitive date is computed AT SEED TIME from
-- date('now', ...) so a freshly cloned demo always looks alive, never pinned to a
-- calendar that has since passed. The anchor is "the first upcoming Sunday",
-- written date('now','weekday 0'): SQLite's 'weekday 0' modifier advances to the
-- next Sunday, or stays put when today is already Sunday (verified). Every other
-- worship date is that anchor plus or minus whole weeks. Plans cover the next 8
-- Sundays; sermons and the published bulletins/prayer sheets sit on recent past
-- Sundays; announcement/event promotion windows straddle today. CRITICAL: the
-- two roster-carrying bulletins (ids 7, 8) reuse the EXACT plan-1/plan-9
-- expression date('now','weekday 0') so the (service_type_id, bulletin_date) join
-- onto the seeded plans/roster still matches. The seed stays fully deterministic
-- on a fresh DB — only the dates float; every id and row count is fixed.
-- IMPORTANT: this file is also loaded raw by test/seed.test.ts, which splits on
-- the statement-terminator character. Do NOT use that character anywhere except
-- to end a statement (Chinese text uses ，。！ and English is phrased to avoid it).
-- Relative date expressions live inside VALUES and use no ';' — D1/SQLite allows
-- computed expressions in an INSERT ... VALUES list.
-- This seed never touches email_rules / email_templates (owned by migration 0002).

-- People: one admin, one editor pastor, eight volunteers (all @example.com).
INSERT INTO people (id, first_name, last_name, display_name, email, phone, role, lang) VALUES
  (1, 'Alex', 'Admin', 'Alex Admin', 'admin@example.com', '(555) 010-1000', 'admin', 'en'),
  (2, 'David', 'Chen', '陈大卫 David Chen', 'pastor.david@example.com', '(555) 010-2000', 'editor', 'zh'),
  (3, 'Sarah', 'Johnson', 'Sarah Johnson 莎拉', 'sarah.johnson@example.com', NULL, 'member', 'en'),
  (4, 'Grace', 'Lin', 'Grace Lin 林恩慈', 'grace.lin@example.com', NULL, 'member', 'zh'),
  (5, 'Mark', 'Liu', 'Mark Liu 刘马可', 'mark.liu@example.com', NULL, 'member', 'zh'),
  (6, 'Faithful', 'Wang', 'Faithful Wang 王信实', 'faithful.wang@example.com', NULL, 'member', 'zh'),
  (7, 'Amy', 'Chen', 'Amy Chen 陈爱美', 'amy.chen@example.com', NULL, 'member', 'zh'),
  (8, 'Ben', 'Wu', 'Ben Wu 吴恩本', 'ben.wu@example.com', NULL, 'member', 'en'),
  (9, 'Esther', 'Lin', 'Esther Lin 林以斯帖', 'esther.lin@example.com', NULL, 'member', 'zh'),
  (10, 'Joshua', 'Zhao', 'Joshua Zhao 赵约书亚', 'joshua.zhao@example.com', NULL, 'member', 'en');

-- Ten ministries with emoji icons and matching categories. Leaders point at the
-- three team leaders plus the senior pastor for the care ministry.
INSERT INTO ministries (id, slug, category, icon, leader_person_id, meeting_time, active, sort) VALUES
  (1, 'worship', 'worship', '🎵', 3, 'Sundays 主日', 1, 1),
  (2, 'children', 'children', '🧒', NULL, 'Sundays 主日', 1, 2),
  (3, 'youth', 'youth', '🔥', NULL, 'Friday nights 周五晚', 1, 3),
  (4, 'college', 'college', '🎓', NULL, 'Saturday evenings 周六晚', 1, 4),
  (5, 'family', 'family', '👨‍👩‍👧', NULL, 'Monthly 每月', 1, 5),
  (6, 'seniors', 'seniors', '🌿', NULL, 'Wednesday mornings 周三上午', 1, 6),
  (7, 'missions', 'missions', '🌏', NULL, 'Quarterly 每季', 1, 7),
  (8, 'care', 'care', '💗', 2, 'As needed 随时', 1, 8),
  (9, 'hospitality', 'hospitality', '🤝', 6, 'Every Sunday 每主日', 1, 9),
  (10, 'av-tech', 'av-tech', '🎥', 8, 'Every Sunday 每主日', 1, 10);

INSERT INTO ministry_i18n (ministry_id, locale, name, intro) VALUES
  (1, 'en', 'Worship', 'We lead the congregation into the presence of God through music, song, and heartfelt praise every Sunday.'),
  (1, 'zh', '敬拜', '我们透过诗歌与真诚的赞美，每主日带领会众一同进到神的面前。'),
  (2, 'en', 'Children', 'A warm and safe place where children hear the good news of Jesus through stories, songs, and play.'),
  (2, 'zh', '儿童', '一个温暖又安全的地方，让孩子们透过故事、诗歌和游戏认识耶稣的好消息。'),
  (3, 'en', 'Youth', 'Middle and high school students grow in faith and friendship through weekly gatherings and retreats.'),
  (3, 'zh', '青少年', '初中和高中学生透过每周聚会与退修会，在信仰和友谊中一同成长。'),
  (4, 'en', 'College', 'A community for university students to study Scripture, ask honest questions, and follow Jesus together.'),
  (4, 'zh', '大学事工', '一个让大学生一起研读圣经、诚实发问、并跟随耶稣的团契。'),
  (5, 'en', 'Family', 'Equipping parents and couples to build homes rooted in the love of Christ.'),
  (5, 'zh', '家庭', '装备父母与夫妻，一同建立以基督的爱为根基的家。'),
  (6, 'en', 'Seniors', 'Our seniors gather for fellowship, prayer, and encouragement in every season of life.'),
  (6, 'zh', '乐龄', '长者们相聚一起团契、祷告，在人生的每个阶段彼此扶持鼓励。'),
  (7, 'en', 'Missions', 'Partnering with churches near and far to share the gospel and serve those in need.'),
  (7, 'zh', '宣教', '与远近的教会同工，一起传扬福音，服事有需要的人。'),
  (8, 'en', 'Care', 'Walking alongside one another in prayer, meals, and practical help during hard times.'),
  (8, 'zh', '关怀', '在艰难的日子里，透过祷告、饭食与实际的帮助彼此同行。'),
  (9, 'en', 'Hospitality', 'The first smile you see on Sunday, welcoming every guest and member as family.'),
  (9, 'zh', '招待', '主日里你看到的第一个笑容，把每位来宾和会众当作家人一样接待。'),
  (10, 'en', 'AV and Tech', 'Serving behind the scenes with sound, slides, and livestream so worship reaches everyone.'),
  (10, 'zh', '媒体技术', '在幕后透过音控、投影与直播摆上，让敬拜能触及每一个人。');

-- Three serving teams under their matching ministries.
INSERT INTO teams (id, ministry_id, sort) VALUES
  (1, 1, 1),
  (2, 10, 2),
  (3, 9, 3);

INSERT INTO team_i18n (team_id, locale, name) VALUES
  (1, 'en', 'Worship Team'),
  (1, 'zh', '敬拜队'),
  (2, 'en', 'AV Team'),
  (2, 'zh', '媒体技术组'),
  (3, 'en', 'Hospitality Team'),
  (3, 'zh', '招待组');

-- Eight positions across the three teams.
INSERT INTO positions (id, team_id, sort) VALUES
  (1, 1, 1),
  (2, 1, 2),
  (3, 1, 3),
  (4, 1, 4),
  (5, 2, 1),
  (6, 2, 2),
  (7, 2, 3),
  (8, 3, 1);

INSERT INTO position_i18n (position_id, locale, name) VALUES
  (1, 'en', 'Worship Leader'),
  (1, 'zh', '领唱'),
  (2, 'en', 'Vocalist'),
  (2, 'zh', '歌手'),
  (3, 'en', 'Pianist'),
  (3, 'zh', '司琴'),
  (4, 'en', 'Acoustic Guitar'),
  (4, 'zh', '木吉他'),
  (5, 'en', 'Sound'),
  (5, 'zh', '音控'),
  (6, 'en', 'Slides'),
  (6, 'zh', '投影'),
  (7, 'en', 'Livestream'),
  (7, 'zh', '直播'),
  (8, 'en', 'Greeter'),
  (8, 'zh', '迎新招待');

-- Team members and leaders. Sarah leads Worship, Ben leads AV, Faithful leads Hospitality.
INSERT INTO team_members (team_id, person_id, is_leader) VALUES
  (1, 3, 1),
  (1, 5, 0),
  (1, 7, 0),
  (2, 8, 1),
  (2, 10, 0),
  (3, 6, 1),
  (3, 9, 0);

-- Two service types with start and end times.
INSERT INTO service_types (id, start_time, end_time, sort) VALUES
  (1, '09:30', '10:45', 1),
  (2, '11:00', '12:15', 2);

INSERT INTO service_type_i18n (service_type_id, locale, name) VALUES
  (1, 'en', 'Sunday Worship (English)'),
  (1, 'zh', '主日崇拜（英文）'),
  (2, 'en', 'Chinese Sunday Worship'),
  (2, 'zh', '中文主日崇拜');

-- Plans: the next 8 Sundays (date('now','weekday 0') + 0..7 weeks) for each
-- service type (16 total). Plan 1 and plan 9 both land on the first upcoming
-- Sunday, the anchor the roster-carrying bulletins (7, 8) reuse verbatim.
INSERT INTO plans (id, service_type_id, plan_date, title, series) VALUES
  (1, 1, date('now','weekday 0'), 'Blessed Are the Poor in Spirit', 'Sermon on the Mount'),
  (2, 1, date('now','weekday 0','+7 days'), 'Salt and Light', 'Sermon on the Mount'),
  (3, 1, date('now','weekday 0','+14 days'), 'Turn the Other Cheek', 'Sermon on the Mount'),
  (4, 1, date('now','weekday 0','+21 days'), 'Love Your Enemies', 'Sermon on the Mount'),
  (5, 1, date('now','weekday 0','+28 days'), 'Do Not Worry', 'Sermon on the Mount'),
  (6, 1, date('now','weekday 0','+35 days'), 'Ask, Seek, Knock', 'Sermon on the Mount'),
  (7, 1, date('now','weekday 0','+42 days'), 'The Narrow Gate', 'Sermon on the Mount'),
  (8, 1, date('now','weekday 0','+49 days'), 'Wise and Foolish Builders', 'Sermon on the Mount'),
  (9, 2, date('now','weekday 0'), '我要向高山举目', '上行之诗'),
  (10, 2, date('now','weekday 0','+7 days'), '耶和华若不建造房屋', '上行之诗'),
  (11, 2, date('now','weekday 0','+14 days'), '我欢喜', '上行之诗'),
  (12, 2, date('now','weekday 0','+21 days'), '从深处向你求告', '上行之诗'),
  (13, 2, date('now','weekday 0','+28 days'), '看哪弟兄和睦同居', '上行之诗'),
  (14, 2, date('now','weekday 0','+35 days'), '我曾在患难中求告耶和华', '上行之诗'),
  (15, 2, date('now','weekday 0','+42 days'), '耶和华恩待谦卑的人', '上行之诗'),
  (16, 2, date('now','weekday 0','+49 days'), '凡敬畏耶和华的', '上行之诗');

-- Positions needed on the two nearest plans of each service type. A couple are
-- open for volunteer self-signup.
INSERT INTO plan_positions (plan_id, position_id, needed, open_signup) VALUES
  (1, 1, 1, 0),
  (1, 2, 2, 1),
  (1, 5, 1, 0),
  (1, 8, 2, 1),
  (2, 1, 1, 0),
  (2, 5, 1, 0),
  (9, 1, 1, 0),
  (9, 3, 1, 0),
  (9, 6, 1, 1),
  (10, 1, 1, 0);

-- Roster with one confirmed, one unconfirmed, one declined (with a reason).
INSERT INTO roster_assignments (plan_id, position_id, person_id, status, decline_reason, is_signup, assigned_by, responded_at) VALUES
  (1, 1, 3, 'C', NULL, 0, 'admin@example.com', datetime('now')),
  (1, 2, 5, 'U', NULL, 0, 'admin@example.com', NULL),
  (1, 2, 7, 'D', 'Out of town 出城', 0, 'admin@example.com', datetime('now')),
  (1, 5, 8, 'C', NULL, 0, 'admin@example.com', datetime('now')),
  (9, 1, 2, 'C', NULL, 0, 'admin@example.com', datetime('now')),
  (9, 3, 4, 'U', NULL, 1, 'admin@example.com', NULL);

-- Ben is away one Sunday — plan 2/10's date (the second upcoming Sunday), so the
-- leader conflict demo has a real blocked-out serving date to collide with.
INSERT INTO blockout_dates (person_id, start_date, end_date, reason) VALUES
  (8, date('now','weekday 0','+7 days'), date('now','weekday 0','+7 days'), 'Family trip 家庭旅行');

-- Three team applications, one of each status (pending, approved, rejected).
INSERT INTO team_applications (person_id, team_id, position_id, message, status, decided_by, decided_at) VALUES
  (9, 1, 2, 'I have sung in choir for years and would love to serve. 我在诗班唱了多年，很想参与服事。', 'P', NULL, NULL),
  (10, 3, 8, 'Happy to welcome newcomers every Sunday. 乐意每主日迎接新朋友。', 'A', 'admin@example.com', datetime('now')),
  (7, 2, 6, 'I can help run slides during worship. 我可以在敬拜时帮忙投影。', 'R', 'admin@example.com', datetime('now'));

-- Self-selected serving interests (feeds the leader potential-volunteers list).
INSERT INTO person_interests (person_id, category) VALUES
  (9, 'worship'),
  (10, 'av-tech');

-- One spiritual-gifts result badge.
INSERT INTO gift_results (person_id, top_gifts_json, recommended_json) VALUES
  (9, '["worship","hospitality"]', '["worship","children"]');

-- Four testimonies: two English, two Chinese, three approved and one pending.
INSERT INTO testimonies (id, person_id, author_name, locale, title, body, category, status, published_at) VALUES
  (1, 8, 'Ben Wu 吴恩本', 'en', 'Found on a Tuesday Night',
   'I wandered into a small group not expecting much. Over a few months the honest friendships and the words of Scripture slowly rebuilt my hope. I gave my life to Jesus on an ordinary Tuesday, and nothing has been ordinary since.',
   'faith', 'A', datetime('now')),
  (2, 5, 'Mark Liu 刘马可', 'zh', '从怀疑到信靠',
   '我曾经觉得信仰只是老一辈的寄托。直到我在最软弱的时候，被一群弟兄默默地陪伴与代祷，我才真正遇见那位又真又活的神。如今我愿意一生跟随祂。',
   'faith', 'A', datetime('now')),
  (3, 7, 'Amy Chen 陈爱美', 'zh', '在敬拜中重新遇见神',
   '有一段时间我服事得很累，几乎想要放下一切。直到某个主日我停下来，单单地敬拜，才重新想起起初的爱。神的恩典把我从枯干中领回丰盛。',
   'worship', 'A', datetime('now')),
  (4, 10, 'Joshua Zhao 赵约书亚', 'en', 'Still Learning to Trust',
   'Trust does not come easily to me. But serving on the AV team taught me that faithfulness in small hidden things is its own kind of worship. I am still learning, one Sunday at a time.',
   'serving', 'P', NULL);

-- Bulletins: per service type two published past Sundays (-3 and -2 weeks), one
-- draft on last Sunday (-1 week), and one published upcoming Sunday
-- (date('now','weekday 0'), the SAME expression as plans 1/9) that matches the
-- seeded plans and roster so the public bulletin page demos the serving block.
-- English service in English content, Chinese service entirely in Chinese content.
INSERT INTO bulletins (id, service_type_id, bulletin_date, service_time_label, program_json, offering_json, attendance_json, memory_verse, flowers, status, publish_at, updated_by) VALUES
  (1, 1, date('now','weekday 0','-21 days'), '9:30 AM',
   '[{"item":"Prelude","content":"","person":"Pianist"},{"item":"Call to Worship","content":"Psalm 100","person":"Sarah Johnson"},{"item":"Praise","content":"How Great Is Our God","person":"Worship Team"},{"item":"Scripture Reading","content":"Matthew 5:13-16","person":"Ben Wu"},{"item":"Message","content":"You Are the Light of the World","person":"Sarah Johnson"},{"item":"Benediction","content":"","person":"Sarah Johnson"}]',
   '[{"label":"General Fund","amount":"8,420"},{"label":"Missions","amount":"1,650"}]',
   '[{"label":"Adults","count":210},{"label":"Kids","count":48}]',
   '"You are the light of the world. A city set on a hill cannot be hidden." (Matthew 5:14)',
   'This week the flowers are given by the Johnson family in thanksgiving.',
   'published', datetime('now','-23 days'), 'admin@example.com'),
  (2, 1, date('now','weekday 0','-14 days'), '9:30 AM',
   '[{"item":"Prelude","content":"","person":"Pianist"},{"item":"Call to Worship","content":"Psalm 95","person":"Sarah Johnson"},{"item":"Praise","content":"In Christ Alone","person":"Worship Team"},{"item":"Scripture Reading","content":"Matthew 5:1-12","person":"Mark Liu"},{"item":"Message","content":"The Beatitudes","person":"Sarah Johnson"},{"item":"Benediction","content":"","person":"Sarah Johnson"}]',
   '[{"label":"General Fund","amount":"9,110"},{"label":"Building","amount":"2,300"}]',
   '[{"label":"Adults","count":205},{"label":"Kids","count":52}]',
   '"Blessed are the pure in heart, for they shall see God." (Matthew 5:8)',
   'Flowers this Sunday celebrate the baptism of two new believers.',
   'published', datetime('now','-16 days'), 'admin@example.com'),
  (3, 1, date('now','weekday 0','-7 days'), '9:30 AM',
   '[{"item":"Prelude","content":"","person":"Pianist"},{"item":"Message","content":"Draft, not yet published","person":"Sarah Johnson"}]',
   NULL, NULL,
   '"Let your light shine before others." (Matthew 5:16)',
   NULL,
   'draft', NULL, 'admin@example.com'),
  (4, 2, date('now','weekday 0','-21 days'), '上午11:00',
   '[{"item":"序乐","content":"","person":"司琴"},{"item":"宣召","content":"诗篇 121 篇","person":"主席"},{"item":"颂赞","content":"这一生最美的祝福","person":"敬拜队"},{"item":"读经","content":"诗篇 121:5-8","person":"刘马可"},{"item":"证道","content":"耶和华看守你","person":"陈大卫牧师"},{"item":"祝福","content":"","person":"陈大卫牧师"}]',
   '[{"label":"经常费","amount":"12,345"},{"label":"宣教","amount":"2,000"}]',
   '[{"label":"中文堂","count":180},{"label":"主日学","count":95}]',
   '「耶和华要保护你免受一切的灾害，他要保护你的性命。」（诗篇 121:7）',
   '本周鲜花由王弟兄一家为感恩摆上。',
   'published', datetime('now','-23 days'), 'admin@example.com'),
  (5, 2, date('now','weekday 0','-14 days'), '上午11:00',
   '[{"item":"序乐","content":"","person":"司琴"},{"item":"宣召","content":"诗篇 120 篇","person":"主席"},{"item":"颂赞","content":"我要向高山举目","person":"敬拜队"},{"item":"读经","content":"诗篇 120 篇","person":"林恩慈传道"},{"item":"证道","content":"在患难中求告","person":"陈大卫牧师"},{"item":"祝福","content":"","person":"陈大卫牧师"}]',
   '[{"label":"经常费","amount":"11,880"},{"label":"建堂","amount":"3,150"}]',
   '[{"label":"中文堂","count":176},{"label":"主日学","count":90}]',
   '「我要向高山举目，我的帮助从何而来。」（诗篇 121:1）',
   '本周鲜花庆祝陈弟兄与李姊妹金婚纪念。',
   'published', datetime('now','-16 days'), 'admin@example.com'),
  (6, 2, date('now','weekday 0','-7 days'), '上午11:00',
   '[{"item":"序乐","content":"","person":"司琴"},{"item":"证道","content":"草稿尚未发布","person":"陈大卫牧师"}]',
   NULL, NULL,
   '「你出你入，耶和华要保护你，从今时直到永远。」（诗篇 121:8）',
   NULL,
   'draft', NULL, 'admin@example.com'),
  (7, 1, date('now','weekday 0'), '9:30 AM',
   '[{"item":"Prelude","content":"","person":"Pianist"},{"item":"Call to Worship","content":"Psalm 84","person":"Sarah Johnson"},{"item":"Praise","content":"Blessed Be Your Name","person":"Worship Team"},{"item":"Scripture Reading","content":"Matthew 5:1-3","person":"Grace Lin"},{"item":"Message","content":"Blessed Are the Poor in Spirit","person":"Sarah Johnson"},{"item":"Benediction","content":"","person":"Sarah Johnson"}]',
   '[{"label":"General Fund","amount":"8,760"},{"label":"Missions","amount":"1,480"}]',
   '[{"label":"Adults","count":198},{"label":"Kids","count":55}]',
   '"Blessed are the poor in spirit, for theirs is the kingdom of heaven." (Matthew 5:3)',
   'This week the flowers are given by the Lin family in praise to God.',
   'published', NULL, 'admin@example.com'),
  (8, 2, date('now','weekday 0'), '上午11:00',
   '[{"item":"序乐","content":"","person":"司琴"},{"item":"宣召","content":"诗篇 122 篇","person":"主席"},{"item":"颂赞","content":"你坐着为王","person":"敬拜队"},{"item":"读经","content":"诗篇 121:1-4","person":"林恩慈传道"},{"item":"证道","content":"我要向高山举目","person":"陈大卫牧师"},{"item":"祝福","content":"","person":"陈大卫牧师"}]',
   '[{"label":"经常费","amount":"12,020"},{"label":"宣教","amount":"1,900"}]',
   '[{"label":"中文堂","count":183},{"label":"主日学","count":92}]',
   '「我的帮助从造天地的耶和华而来。」（诗篇 121:2）',
   '本周鲜花由林姊妹一家为赞美神摆上。',
   'published', NULL, 'admin@example.com');

-- Three announcements per published bulletin, two per draft.
INSERT INTO bulletin_announcements (bulletin_id, seq, title, body, link_url, link_label) VALUES
  (1, 1, 'Summer Bible Camp', 'Registration for our Summer Bible Camp is now open. Invite the children in your neighborhood to join us.', 'https://church.yunfei-song.com/en/events', 'Learn more'),
  (1, 2, 'Church Picnic', 'Join us for an all-church picnic on July 26 at Grace Park. Bring a dish to share and a friend.', NULL, NULL),
  (1, 3, 'New Members Class', 'Interested in joining Church4Christ? Our new members class meets on the first Sunday of each month.', NULL, NULL),
  (2, 1, 'Baptism Sunday', 'We celebrate two baptisms today. Come rejoice with those taking this step of faith.', NULL, NULL),
  (2, 2, 'Volunteers Needed', 'The Hospitality Team is looking for a few more greeters. Speak with Faithful Wang to serve.', NULL, NULL),
  (2, 3, 'Give Online', 'You can now support the ministries of the church through our secure online giving page.', 'https://give.example.com/church4christ', 'Give now'),
  (3, 1, 'Draft Notice', 'This bulletin is still a draft and is not yet published.', NULL, NULL),
  (3, 2, 'Coming Soon', 'The full program for this Sunday will appear here once finalized.', NULL, NULL),
  (4, 1, '暑期圣经营', '暑期圣经营现已开始报名，欢迎邀请邻里的孩子一同参加。', 'https://church.yunfei-song.com/zh/events', '了解详情'),
  (4, 2, '教会野餐', '七月二十六日全教会将在恩典公园举行野餐，请带一道菜与一位朋友同来。', NULL, NULL),
  (4, 3, '新朋友课程', '想要认识四方基督教会吗，新朋友课程于每月第一个主日聚会。', NULL, NULL),
  (5, 1, '受洗主日', '今日有两位弟兄姊妹受洗，欢迎一同为他们踏出的信心脚步欢喜快乐。', NULL, NULL),
  (5, 2, '招募同工', '招待组正在寻找几位迎新同工，愿意服事的请与王信实弟兄联系。', NULL, NULL),
  (5, 3, '网上奉献', '现已开通安全的网上奉献页面，欢迎透过它支持教会各项事工。', 'https://give.example.com/church4christ', '立即奉献'),
  (6, 1, '草稿通知', '本期周报仍是草稿，尚未正式发布。', NULL, NULL),
  (6, 2, '敬请期待', '本主日完整程序将于定稿后显示于此。', NULL, NULL),
  (7, 1, 'Summer Bible Camp', 'Camp week is almost here. Pray for the children and volunteers as final preparations wrap up.', 'https://church.yunfei-song.com/en/events', 'Learn more'),
  (7, 2, 'Church Picnic', 'The all-church picnic is two weeks away on July 26 at Grace Park. Sign up to bring a dish.', NULL, NULL),
  (7, 3, 'Serve on Sunday Mornings', 'The Worship and AV teams welcome new members. Speak with Sarah Johnson or Ben Wu to get started.', NULL, NULL),
  (8, 1, '暑期圣经营', '圣经营下周开营，请为孩子们与同工的最后预备祷告。', 'https://church.yunfei-song.com/zh/events', '了解详情'),
  (8, 2, '教会野餐', '全教会野餐将于七月二十六日在恩典公园举行，欢迎报名带一道菜。', NULL, NULL),
  (8, 3, '主日服事招募', '敬拜队与媒体技术组欢迎新同工加入，有意者请与莎拉姊妹或吴恩本弟兄联系。', NULL, NULL);

-- Ten sermons across both service types, on recent past Sundays
-- (date('now','weekday 0') minus 1..6 weeks). Nine published and one draft.
INSERT INTO sermons (id, service_type_id, sermon_date, title, speaker, scripture, youtube_id, series, status, updated_by) VALUES
  (1, 1, date('now','weekday 0','-14 days'), 'The Beatitudes', 'Sarah Johnson', 'Matthew 5:1-12', 'zzDEMO00001', 'Sermon on the Mount', 'published', 'admin@example.com'),
  (2, 1, date('now','weekday 0','-21 days'), 'You Are the Light of the World', 'Sarah Johnson', 'Matthew 5:13-16', 'zzDEMO00002', 'Sermon on the Mount', 'published', 'admin@example.com'),
  (3, 1, date('now','weekday 0','-28 days'), 'Teach Us to Pray', 'Grace Lin', 'Matthew 6:5-15', 'zzDEMO00003', 'Sermon on the Mount', 'published', 'admin@example.com'),
  (4, 1, date('now','weekday 0','-35 days'), 'Treasures in Heaven', 'Sarah Johnson', 'Matthew 6:19-24', 'zzDEMO00004', 'Sermon on the Mount', 'published', 'admin@example.com'),
  (5, 1, date('now','weekday 0','-42 days'), 'Build on the Rock', 'Mark Liu', 'Matthew 7:24-29', 'zzDEMO00005', 'Sermon on the Mount', 'published', 'admin@example.com'),
  (6, 2, date('now','weekday 0','-14 days'), '向高山举目', '陈大卫牧师', '诗篇 121 篇', 'zzDEMO00006', '上行之诗', 'published', 'admin@example.com'),
  (7, 2, date('now','weekday 0','-21 days'), '耶和华看守你', '陈大卫牧师', '诗篇 121:5-8', 'zzDEMO00007', '上行之诗', 'published', 'admin@example.com'),
  (8, 2, date('now','weekday 0','-28 days'), '和睦同居', '林恩慈传道', '诗篇 133 篇', 'zzDEMO00008', '上行之诗', 'published', 'admin@example.com'),
  (9, 2, date('now','weekday 0','-35 days'), '在患难中求告', '刘马可', '诗篇 120 篇', 'zzDEMO00009', '上行之诗', 'published', 'admin@example.com'),
  (10, 2, date('now','weekday 0','-7 days'), '上行之诗预告', '陈大卫牧师', NULL, 'zzDEMO00010', '上行之诗', 'draft', 'admin@example.com');

-- Two published prayer sheets in Chinese, on recent past dates so the public
-- prayer page always shows a fresh-looking latest sheet (sheet 2 is the newer):
-- sheet 1 on the -2-week Sunday, sheet 2 a few days ago (a mid-week sheet).
INSERT INTO prayer_sheets (id, sheet_date, locale, sections_json, status, publish_at, updated_by) VALUES
  (1, date('now','weekday 0','-14 days'), 'zh',
   '[{"heading":"感恩","items":["感谢神保守上主日崇拜顺利","感谢弟兄姊妹忠心的服事"]},{"heading":"教会与同工","items":["为牧者及同工身心灵健壮祷告","为新学期的儿童事工预备祷告"]},{"heading":"宣教","items":["为暑期短宣队的行前预备祷告"]}]',
   'published', datetime('now','weekday 0','-18 days','start of day','+8 hours'), 'admin@example.com'),
  (2, date('now','-5 days'), 'zh',
   '[{"heading":"感恩","items":["感谢神赐下平安稳妥的一周","感谢新朋友愿意固定聚会"]},{"heading":"关怀","items":["为患病的长者早日康复祷告","为待产的姊妹母子平安祷告"]},{"heading":"社区","items":["为城市的需要与福音的广传祷告"]}]',
   'published', datetime('now','-7 days'), 'admin@example.com');

-- Four announcements. Three are active and span today (windows straddle now via
-- datetime('now', ...)), one is past-expired (both bounds behind now, inactive).
INSERT INTO announcements (id, url, sort, active, starts_at, ends_at) VALUES
  (1, 'https://church.yunfei-song.com/en/events', 1, 1, datetime('now','-34 days'), datetime('now','+57 days')),
  (2, NULL, 2, 1, datetime('now','-5 days'), datetime('now','+25 days')),
  (3, NULL, 3, 1, NULL, NULL),
  (4, NULL, 4, 0, datetime('now','-95 days'), datetime('now','-65 days'));

INSERT INTO announcement_i18n (announcement_id, locale, title) VALUES
  (1, 'en', 'Summer Bible Camp registration is open'),
  (1, 'zh', '暑期圣经营开始报名'),
  (2, 'en', 'All-church picnic on July 26'),
  (2, 'zh', '七月二十六日全教会野餐'),
  (3, 'en', 'New members class every first Sunday'),
  (3, 'zh', '新朋友课程每月首个主日'),
  (4, 'en', 'Spring cleanup day (past)'),
  (4, 'zh', '春季大扫除（已结束）');

-- Three events. starts_at/ends_at are PROMOTION WINDOWS (when the card shows on
-- the public site), not the event's own start/end times. Events 1-2 have windows
-- straddling today (datetime('now', ...)) so they always show on the home page,
-- and event 3 is the past-expired windowing demo (also inactive).
INSERT INTO events (id, image_key, url, sort, active, starts_at, ends_at) VALUES
  (1, NULL, 'https://church.yunfei-song.com/en/events', 1, 1, datetime('now','-5 days'), datetime('now','+20 days')),
  (2, NULL, NULL, 2, 1, datetime('now','-5 days'), datetime('now','+25 days')),
  (3, NULL, NULL, 3, 0, datetime('now','-57 days'), datetime('now','-56 days'));

INSERT INTO event_i18n (event_id, locale, title, blurb) VALUES
  (1, 'en', 'Summer Bible Camp', 'A joyful week of stories, songs, and games for children entering grades 1 through 6.'),
  (1, 'zh', '暑期圣经营', '为升小学一至六年级的孩子预备的一周，充满故事、诗歌与游戏。'),
  (2, 'en', 'Baptism Sunday', 'Celebrate with those taking the step of baptism this July. Speak with a pastor to sign up.'),
  (2, 'zh', '受洗主日', '七月与预备受洗的弟兄姊妹一同欢喜，有意受洗者请与牧者联系。'),
  (3, 'en', 'Easter Celebration', 'Our joyful Easter gathering with worship and a shared meal (this event has ended).'),
  (3, 'zh', '复活节庆祝', '满有喜乐的复活节聚会，一同敬拜并享用爱筵（此活动已结束）。');

-- Five prayer requests spread across the kanban statuses.
INSERT INTO prayer_requests (id, name, email, message, status) VALUES
  (1, 'Anna Lee 李安娜', 'anna.lee@example.com', '请为我年迈的母亲身体健康祷告，也求神赐给我们全家平安。', 'new'),
  (2, 'Tom Park', 'tom.park@example.com', 'Please pray for a job interview next week. I am trusting God for provision and peace.', 'praying'),
  (3, '陈稳', 'wen.chen@example.com', '为一位还未信主的家人祷告，愿他早日认识主的爱，这是长久以来的心愿。', 'long_term'),
  (4, 'Maria Gomez', 'maria.gomez@example.com', 'Praying about a big decision for our family. Asking God for wisdom and clear direction.', 'waiting'),
  (5, '王小明', 'xiaoming.wang@example.com', '感谢神，上个月分享的手术已经顺利完成，恢复得很好，愿一切荣耀归给神。', 'answered');

INSERT INTO prayer_activity (request_id, author, kind, body) VALUES
  (2, 'Alex Admin', 'prayed', NULL),
  (2, 'Sarah Johnson', 'comment', 'Praying for peace and favor in your interview.'),
  (3, 'Alex Admin', 'prayed', NULL),
  (5, 'Alex Admin', 'moved', 'Answered — praise God for a good recovery.');

-- People module (Slice 9). membership_status spreads across all four values and
-- joined_on is set for every 'member'; both are ADMIN-SET fields. Person 5 (Mark)
-- is intentionally left at the default 'visitor' with no joined_on so the
-- self-service privilege-strip e2e still proves those columns are not editable
-- from /profile. birthday/address add profile depth for the Chen household demo.
UPDATE people SET membership_status = 'member', joined_on = date('now','-9 years') WHERE id = 1;
UPDATE people SET membership_status = 'member', joined_on = date('now','-11 years'), birthday = '1978-04-12', address = '88 Cornerstone Way, Springfield, TX 75000' WHERE id = 2;
UPDATE people SET membership_status = 'member', joined_on = date('now','-7 years') WHERE id = 3;
UPDATE people SET membership_status = 'regular' WHERE id = 4;
UPDATE people SET membership_status = 'member', joined_on = date('now','-8 years') WHERE id = 6;
UPDATE people SET membership_status = 'member', joined_on = date('now','-10 years'), birthday = '1981-09-30', address = '88 Cornerstone Way, Springfield, TX 75000' WHERE id = 7;
UPDATE people SET membership_status = 'regular' WHERE id = 8;
UPDATE people SET membership_status = 'visitor' WHERE id = 9;
UPDATE people SET membership_status = 'inactive' WHERE id = 10;

-- Three households: (1) the Chen family — two real adults (David primary + Amy)
-- and a name-only child dependent (person_id NULL); (2) the Lin sisters — two
-- real adults; (3) a single-adult household. Member display_name mirrors what the
-- createHousehold path copies from the people row.
INSERT INTO households (id, name, address, phone) VALUES
  (1, 'Chen Family 陈家', '88 Cornerstone Way, Springfield, TX 75000', '(555) 010-2000'),
  (2, 'Lin Family 林家', '12 Riverbend Road, Springfield, TX 75000', '(555) 010-4040'),
  (3, 'Zhao Household 赵家', '5 Maple Court, Springfield, TX 75000', NULL);

INSERT INTO household_members (id, household_id, person_id, display_name, role, is_primary) VALUES
  (1, 1, 2, '陈大卫 David Chen', 'adult', 1),
  (2, 1, 7, 'Amy Chen 陈爱美', 'adult', 0),
  (3, 1, NULL, 'Ethan Chen 陈以恒', 'child', 0),
  (4, 2, 4, 'Grace Lin 林恩慈', 'adult', 1),
  (5, 2, 9, 'Esther Lin 林以斯帖', 'adult', 0),
  (6, 3, 10, 'Joshua Zhao 赵约书亚', 'adult', 1);

-- Two admin-authored pastoral notes on two different people. Notes are an
-- admin-only surface and never render on any public or leader page.
INSERT INTO person_notes (id, person_id, author_email, body) VALUES
  (1, 2, 'admin@example.com', 'Met with David to plan the fall newcomers class and the visitation rota. He has been mentoring two newer volunteers and is a real encouragement to the team.'),
  (2, 9, 'admin@example.com', 'Esther visited for the first time this month and joined the college fellowship. Follow up with a welcome call and an invite to the next newcomers lunch.');

-- Site settings. Localized keys carry a .locale suffix and fall back to .en.
INSERT INTO settings (key, value) VALUES
  ('site.name.en', 'Church4Christ'),
  ('site.name.zh', '四方基督教会'),
  ('site.tagline.en', 'A church for the city'),
  ('site.tagline.zh', '城市中的教会'),
  ('site.service_times.en', 'Sundays 9:30 AM (English) and 11:00 AM (Chinese)'),
  ('site.service_times.zh', '主日上午九点半（英文）与十一点（中文）'),
  ('site.address', '123 Grace Avenue, Springfield, TX 75000'),
  ('site.email', 'hello@church.yunfei-song.com'),
  ('site.phone', '(555) 010-4444'),
  ('site.map_url', 'https://maps.example.com/church4christ'),
  ('site.giving_url', 'https://give.example.com/church4christ'),
  ('site.youtube_url', 'https://www.youtube.com/@church4christ-demo'),
  ('theme.name', 'sanctuary'),
  ('theme.default_mode', 'light'),
  ('locale.default', 'en');

-- Generated demo media. SQL registers metadata and references, while
-- npm run db:seed-media:local writes the matching objects into local R2.
INSERT INTO media (r2_key, filename, content_type, size, uploaded_by) VALUES
  ('uploads/c69a962386c72642-hero-worship-gathering.webp', 'hero-worship-gathering.webp', 'image/webp', 2077844, 'admin@example.com'),
  ('uploads/40f5b98116a62896-event-summer-bible-camp.webp', 'event-summer-bible-camp.webp', 'image/webp', 1576678, 'admin@example.com'),
  ('uploads/642d06377d239e71-event-baptism-sunday.webp', 'event-baptism-sunday.webp', 'image/webp', 1390614, 'admin@example.com'),
  ('uploads/fdbd2ae3fa492026-event-easter-celebration.webp', 'event-easter-celebration.webp', 'image/webp', 1419232, 'admin@example.com'),
  ('uploads/9671f1fd3e756140-ministry-worship.webp', 'ministry-worship.webp', 'image/webp', 1301514, 'admin@example.com'),
  ('uploads/58145914a7b1b4ac-ministry-children.webp', 'ministry-children.webp', 'image/webp', 1408968, 'admin@example.com'),
  ('uploads/5299e7e1e2a360a0-ministry-youth.webp', 'ministry-youth.webp', 'image/webp', 1487918, 'admin@example.com'),
  ('uploads/152c97361f2c15e9-ministry-college.webp', 'ministry-college.webp', 'image/webp', 1459502, 'admin@example.com'),
  ('uploads/25cf15f0049db1fb-ministry-family.webp', 'ministry-family.webp', 'image/webp', 1624436, 'admin@example.com'),
  ('uploads/3a25836b4b621331-ministry-seniors.webp', 'ministry-seniors.webp', 'image/webp', 1438024, 'admin@example.com'),
  ('uploads/c954a9f2fdd4b08d-avatar-david-chen.webp', 'avatar-david-chen.webp', 'image/webp', 954570, 'admin@example.com'),
  ('uploads/24f8da6ed4434eb3-avatar-sarah-johnson.webp', 'avatar-sarah-johnson.webp', 'image/webp', 991284, 'admin@example.com'),
  ('uploads/1a0ee9b979516044-avatar-grace-lin.webp', 'avatar-grace-lin.webp', 'image/webp', 968132, 'admin@example.com'),
  ('uploads/0da5e291631d6175-avatar-mark-liu.webp', 'avatar-mark-liu.webp', 'image/webp', 978082, 'admin@example.com'),
  ('uploads/06eabb4919549133-avatar-faithful-wang.webp', 'avatar-faithful-wang.webp', 'image/webp', 1082376, 'admin@example.com'),
  ('uploads/c0126d218e4f4462-avatar-amy-chen.webp', 'avatar-amy-chen.webp', 'image/webp', 964960, 'admin@example.com'),
  ('uploads/624b72ae921a3faf-avatar-ben-wu.webp', 'avatar-ben-wu.webp', 'image/webp', 840180, 'admin@example.com'),
  ('uploads/05218adece952076-avatar-esther-lin.webp', 'avatar-esther-lin.webp', 'image/webp', 930548, 'admin@example.com');

INSERT INTO settings (key, value) VALUES
  ('site.hero_image_key', 'uploads/c69a962386c72642-hero-worship-gathering.webp');

UPDATE events SET image_key = 'uploads/40f5b98116a62896-event-summer-bible-camp.webp' WHERE id = 1;
UPDATE events SET image_key = 'uploads/642d06377d239e71-event-baptism-sunday.webp' WHERE id = 2;
UPDATE events SET image_key = 'uploads/fdbd2ae3fa492026-event-easter-celebration.webp' WHERE id = 3;

UPDATE ministries SET cover_key = 'uploads/9671f1fd3e756140-ministry-worship.webp' WHERE id = 1;
UPDATE ministries SET cover_key = 'uploads/58145914a7b1b4ac-ministry-children.webp' WHERE id = 2;
UPDATE ministries SET cover_key = 'uploads/5299e7e1e2a360a0-ministry-youth.webp' WHERE id = 3;
UPDATE ministries SET cover_key = 'uploads/152c97361f2c15e9-ministry-college.webp' WHERE id = 4;
UPDATE ministries SET cover_key = 'uploads/25cf15f0049db1fb-ministry-family.webp' WHERE id = 5;
UPDATE ministries SET cover_key = 'uploads/3a25836b4b621331-ministry-seniors.webp' WHERE id = 6;

UPDATE people SET avatar_url = '/media/uploads/c954a9f2fdd4b08d-avatar-david-chen.webp' WHERE id = 2;
UPDATE people SET avatar_url = '/media/uploads/24f8da6ed4434eb3-avatar-sarah-johnson.webp' WHERE id = 3;
UPDATE people SET avatar_url = '/media/uploads/1a0ee9b979516044-avatar-grace-lin.webp' WHERE id = 4;
UPDATE people SET avatar_url = '/media/uploads/0da5e291631d6175-avatar-mark-liu.webp' WHERE id = 5;
UPDATE people SET avatar_url = '/media/uploads/06eabb4919549133-avatar-faithful-wang.webp' WHERE id = 6;
UPDATE people SET avatar_url = '/media/uploads/c0126d218e4f4462-avatar-amy-chen.webp' WHERE id = 7;
UPDATE people SET avatar_url = '/media/uploads/624b72ae921a3faf-avatar-ben-wu.webp' WHERE id = 8;
UPDATE people SET avatar_url = '/media/uploads/05218adece952076-avatar-esther-lin.webp' WHERE id = 9;

-- Children's check-in (Task 7): two name-only child dependents added to each of
-- the Chen and Lin households (person_id NULL, same convention as Ethan Chen
-- above), Grace Lin (person 4) given the Lin household's phone so the kiosk's
-- phone-mode search also matches an adult, one active Sunday check-in event,
-- and ten historical checkins on the 6 most recent Sundays (date('now','weekday
-- 0','-7 days') through '-42 days', the SAME relative-Sunday expressions the
-- sermons/prayer_sheets blocks above use) so the admin dashboard's 12-week
-- chart renders non-empty on a freshly seeded, freshly cloned DB.
INSERT INTO household_members (id, household_id, person_id, display_name, role, is_primary) VALUES
  (7, 1, NULL, 'Mia Chen 陈米娅', 'child', 0),
  (8, 2, NULL, 'Noah Lin 林诺亚', 'child', 0),
  (9, 2, NULL, 'Lily Lin 林莉莉', 'child', 0);

UPDATE people SET phone = '(555) 010-4040' WHERE id = 4;

INSERT INTO checkin_events (id, name, weekday, active) VALUES
  (1, 'Sunday Kids 主日儿童', 0, 1);

INSERT INTO checkins (id, event_id, household_id, household_member_id, child_name, security_code, checkin_date, checked_in_at) VALUES
  (1, 1, 1, 3, 'Ethan Chen 陈以恒', 'K7XQ', date('now','weekday 0','-7 days'), datetime('now','weekday 0','-7 days','start of day','+9 hours')),
  (2, 1, 1, 7, 'Mia Chen 陈米娅', 'K7XQ', date('now','weekday 0','-7 days'), datetime('now','weekday 0','-7 days','start of day','+9 hours')),
  (3, 1, 2, 8, 'Noah Lin 林诺亚', 'M3N9', date('now','weekday 0','-14 days'), datetime('now','weekday 0','-14 days','start of day','+9 hours')),
  (4, 1, 2, 9, 'Lily Lin 林莉莉', 'M3N9', date('now','weekday 0','-14 days'), datetime('now','weekday 0','-14 days','start of day','+9 hours')),
  (5, 1, 1, 3, 'Ethan Chen 陈以恒', 'P2R8', date('now','weekday 0','-21 days'), datetime('now','weekday 0','-21 days','start of day','+9 hours')),
  (6, 1, 1, 7, 'Mia Chen 陈米娅', 'T5V3', date('now','weekday 0','-28 days'), datetime('now','weekday 0','-28 days','start of day','+9 hours')),
  (7, 1, 2, 8, 'Noah Lin 林诺亚', 'W9Y4', date('now','weekday 0','-28 days'), datetime('now','weekday 0','-28 days','start of day','+9 hours')),
  (8, 1, 2, 9, 'Lily Lin 林莉莉', 'C6D2', date('now','weekday 0','-35 days'), datetime('now','weekday 0','-35 days','start of day','+9 hours')),
  (9, 1, 1, 3, 'Ethan Chen 陈以恒', 'F8G5', date('now','weekday 0','-42 days'), datetime('now','weekday 0','-42 days','start of day','+9 hours')),
  (10, 1, 2, 8, 'Noah Lin 林诺亚', 'H4J7', date('now','weekday 0','-42 days'), datetime('now','weekday 0','-42 days','start of day','+9 hours'));

-- Kiosk token: fixed (not random) so the kiosk works immediately after a local
-- seed. With the default `astro dev` port, open:
--   http://localhost:4321/kiosk/devkiosk1234567890abcdef12345678
INSERT INTO settings (key, value) VALUES
  ('children.kiosk_token', 'devkiosk1234567890abcdef12345678');

-- Member portal (Task 7): the Chen household's primary adult (David, member id
-- 1) is its first owner, so /my/household has real owner-only demo data
-- (promote/demote a co-owner) without any manual setup.
UPDATE household_members SET is_owner = 1 WHERE id = 1;

-- Two member_groups (Phase 2 data): one long-running fellowship, one seasonal
-- Sunday School class carrying term_label/term_start/term_end. term_start/
-- term_end are relative (date('now', ...)) so the class always reads as
-- "in session" on a freshly seeded DB, same convention as the worship dates above.
INSERT INTO member_groups (id, slug, kind, term_label, term_start, term_end, active, sort) VALUES
  (1, 'young-adults', 'fellowship', NULL, NULL, NULL, 1, 1),
  (2, 'foundations-of-faith', 'sunday_school', '2026 Fall', date('now','-30 days'), date('now','+60 days'), 1, 2);

INSERT INTO member_group_i18n (group_id, locale, name, description) VALUES
  (1, 'en', 'Young Adults Fellowship', 'College grads and young professionals meeting weekly for food, discussion, and prayer.'),
  (1, 'zh', '青年团契', '大学毕业生与青年专业人士每周聚会，一同用餐、分享与祷告。'),
  (2, 'en', 'Foundations of Faith', 'A Sunday School class walking through the basics of Christian belief and practice.'),
  (2, 'zh', '信仰基础', '主日学课程，带领学员认识基督教信仰与实践的基础。');

-- Five legacy fellowships (ported from the retired astro:content collection,
-- Task 3): real meeting details as structured fields, ids continuing after the
-- two rows above. 'campus' is referenced by test/e2e/public.test.ts.
INSERT INTO member_groups
  (id, slug, kind, meeting_weekday, meeting_time, meeting_frequency, meeting_location, active, sort) VALUES
  (3, 'young-professionals', 'fellowship', 5, '19:30', 'weekly', 'Room 201', 1, 3),
  (4, 'family', 'fellowship', 6, '17:00', 'weekly', 'Fellowship Hall', 1, 4),
  (5, 'seniors', 'fellowship', 3, '10:00', 'weekly', 'Room 105', 1, 5),
  (6, 'campus', 'fellowship', 4, '19:00', 'weekly', 'Room 203', 1, 6),
  (7, 'english-young-adults', 'fellowship', 0, '13:00', 'weekly', 'Café Corner', 1, 7);

INSERT INTO member_group_i18n (group_id, locale, name, description) VALUES
  (3, 'en', 'Young Professionals Fellowship', 'A home for working adults navigating early career and adulthood, meeting Friday evenings for a meal, Scripture, and honest conversation in small groups.'),
  (3, 'zh', '职青团契', '为在职青年预备的团契，周五晚上一同吃饭、查经，在小组中坦诚交流。'),
  (4, 'en', 'Family Fellowship', 'A gathering for couples and parents raising children, meeting Saturday afternoons to share life, study Scripture, and pray for one another''s families — kids welcome.'),
  (4, 'zh', '家庭团契', '为已婚夫妇及有孩子的家庭预备的聚会，周六下午一同分享生活、查考圣经，为彼此的家庭祷告，欢迎带着孩子参加。'),
  (5, 'en', 'Seniors Fellowship', 'An unhurried, warm gathering for retirees and older members, meeting Wednesday mornings over tea and Scripture.'),
  (5, 'zh', '长者团契', '为退休及年长弟兄姊妹预备的从容聚会，周三上午一同品茶、查考圣经。'),
  (6, 'en', 'Campus Fellowship', 'A community for university and college students, meeting Thursday evenings to study the Bible honestly and build lasting friendships.'),
  (6, 'zh', '学生团契', '为大专院校学生预备的团契，周四晚上一同诚实地查考圣经，建立长久的友谊。'),
  (7, 'en', 'English Young Adults', 'A community for those who do life mostly in English, meeting after Sunday services over coffee to read Scripture and share life together.'),
  (7, 'zh', '英语青年团契', '为以英语为主要生活语言的青年预备的团契，主日聚会后一同喝咖啡、读经、分享生活。');
