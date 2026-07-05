CREATE TABLE email_rules (
  rule_key TEXT PRIMARY KEY CHECK (rule_key IN ('remind7','remind3','digestAM')),
  enabled INTEGER NOT NULL DEFAULT 0
);
INSERT INTO email_rules (rule_key, enabled) VALUES
  ('remind7', 1), ('remind3', 0), ('digestAM', 1);

CREATE TABLE email_templates (
  template_key TEXT NOT NULL CHECK (template_key IN ('remind','request','appResult','digestAM')),
  locale TEXT NOT NULL CHECK (locale IN ('en','zh')),
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (template_key, locale)
);

INSERT INTO email_templates (template_key, locale, subject, body) VALUES
  ('remind', 'en', 'Reminder: you''re serving on {date}',
    'Hi {name}, just a friendly reminder that you''re scheduled to serve as {position} on {date}. Please confirm here: {link}'),
  ('remind', 'zh', '服事提醒：{date}',
    '{name} 平安！温馨提醒您已安排于 {date} 担任 {position} 服事，请点击确认：{link}'),
  ('request', 'en', 'New serving request for {date}',
    'Hi {name}, we''d love to have you serve as {position} on {date}. Please let us know if you''re available: {link}'),
  ('request', 'zh', '服事邀请：{date}',
    '{name} 平安！诚邀您于 {date} 担任 {position} 服事，请点击回复是否方便：{link}'),
  ('appResult', 'en', 'Your team application update',
    'Hi {name}, thank you for applying to serve! We''re happy to let you know your application has been approved. View the details here: {link}'),
  ('appResult', 'zh', '您的服事申请结果',
    '{name} 平安！感谢您愿意委身服事，您的申请已获批准，欢迎点击查看详情：{link}'),
  ('digestAM', 'en', 'Your weekly serving digest',
    'Hi {name}, here''s a look at the upcoming serving schedule for your teams. Full details here: {link}'),
  ('digestAM', 'zh', '本周服事摘要',
    '{name} 平安！以下是您所在服事团队的近期安排，完整内容请点击：{link}');

CREATE TABLE email_log (
  id INTEGER PRIMARY KEY,
  to_email TEXT NOT NULL,
  to_name TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  detail TEXT,
  status TEXT NOT NULL CHECK (status IN ('sent','delivered','opened','bounced','failed','devlog')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_email_log_created ON email_log(created_at);
