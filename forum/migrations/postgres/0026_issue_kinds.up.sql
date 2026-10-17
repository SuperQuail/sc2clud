-- 0026_issue_kinds：Issue 类型改成**数据/配置驱动**的值域（拍板 08 · J6）。
--
-- 用户原话：「可变,只是当前是四类,之后有可能增加」。原来值域写死在两处：
--   · 0005 的 `ck_post_issues_kind CHECK (kind IN (...))`
--   · forum/internal/forum/issues.go 的 validIssueKind switch
-- 于是「加一类」= 改迁移 + 改代码 + 发版，而它本来就只是一张字典表的事。
--
-- 这一版的形态（三条取舍写在这里，免得下次再讨论）：
--   1. **值域表** issue_kinds(key/name/sort/archived)：key 进 post_issues.kind，name 是给人看的标签。
--   2. **约束换成正经外键**（DROP CHECK → ADD FOREIGN KEY）。外键是**引用完整性**，不是枚举：
--      它允许任何插进 issue_kinds 的值，而 CHECK 不行 —— 这正是「可变」要的东西。
--      ON DELETE RESTRICT：还有 Issue 在用的类型删不掉（archive 一条更合适，所以留了 archived）。
--   3. **不预设「以后有哪些」**：表里只有当前四类；加一类是 INSERT 一行（或后台），不是发版。

CREATE TABLE issue_kinds (
  key        varchar(32)  PRIMARY KEY,
  name       varchar(32)  NOT NULL,
  description varchar(200) NOT NULL DEFAULT '',
  sort       int          NOT NULL DEFAULT 0,
  -- archived = 不再出现在新建入口与筛选项里，但历史 Issue 仍然显示得出它的 name。
  archived   boolean      NOT NULL DEFAULT false,
  created_at timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT ck_issue_kinds_key CHECK (key ~ '^[a-z][a-z0-9_]{0,31}$')
);

-- 当前四类（§3.2）。difficulty 是「难度建议」——战役 mod 社区作者最需要的一类反馈。
INSERT INTO issue_kinds (key, name, description, sort) VALUES
  ('bug',        'Bug 汇报', '功能不对、崩溃、卡关与其它缺陷', 1),
  ('feature',    '功能建议', '想要的新功能或改动',           2),
  ('difficulty', '难度建议', '关卡难度与平衡相关的建议',     3),
  ('other',      '其他',     '不属于以上三类的反馈',         4)
ON CONFLICT (key) DO NOTHING;

-- 值域从 CHECK 换成外键：先删旧约束（名字是 0005 里的那个），再加新的。
ALTER TABLE post_issues DROP CONSTRAINT IF EXISTS ck_post_issues_kind;
ALTER TABLE post_issues ADD CONSTRAINT fk_post_issues_kind
  FOREIGN KEY (kind) REFERENCES issue_kinds(key) ON DELETE RESTRICT;

-- 外键列必须有自己的索引（PG 不自动建；platform/db 的启动自检会红）。
-- 它同时服务「按类型筛选」（§3.1 的 ?kind=）。
CREATE INDEX idx_post_issues_kind ON post_issues (kind);
