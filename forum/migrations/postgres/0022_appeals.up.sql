-- 0022_appeals：申诉与反馈（C4 免登录申诉 + C5 帖子审核申诉）
--
-- 依据：完全重构/盲审合并结论.md §7（登录页让人「联系管理员」，但被封者登不进来、发不了帖）、
-- 拍板 §10.10-1（POST /topics/{id}/review/appeal：登录 + 仅作者 + 幂等）、
-- DevRoom 设计稿 web/src/devroom/pages/17-appeal/data.ts（四种事由、四种状态）。
--
-- 一条链路、两种来者：
--   · 免登录（被封的人）：用户名 + 注册邮箱 + 图形验证码自证，**验不过也照收**（收下是本域存在的理由，
--     人判的时候看就没有 identity_verified 那一列）；
--   · 已登录（帖子被驳回的作者）：端点只认作者本人，表里因此多一列 topic_id 指向那篇帖子。
-- 状态只有三值（pending/replied/closed）；设计稿第四态「已驳回」= 判定 upheld，由 decision 列表达 ——
-- 「这条被驳回了」与「这条还开着还是关了」是两件事，挤进一个列以后无法回答「驳回之后还能不能补充材料」。

CREATE TABLE appeals (
  id                  bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id           uuid         NOT NULL UNIQUE,
  -- 对外单号。设计稿与前端都叫 no（routes/appeal.tsx 显示的就是它），所以列名就是 no，不做映射。
  -- 生成列而不是自增列：AP-<id+2000> 稳定、可读、不可枚举（它同时是免登录查进展的凭据之一，见 no+email 查询）。
  no                  varchar(16)  GENERATED ALWAYS AS ('AP-' || (id + 2000)::text) STORED,
  type                text         NOT NULL,
  -- 自证身份：提交时给的账号串（用户名或邮箱），原样存一份，管理员拿它跟 user_id 互相对照。
  username            varchar(64)  NOT NULL,
  email               varchar(254) NOT NULL,
  user_id             bigint       NULL REFERENCES users(id)  ON DELETE SET NULL,
  -- 两端都验过（用户存在 且 邮箱与账号一致）才为 true。false 不是拒绝 —— 是「这条要人眼核一下」。
  identity_verified   boolean      NOT NULL DEFAULT false,
  topic_id            bigint       NULL REFERENCES topics(id) ON DELETE SET NULL,
  ref                 varchar(200) NOT NULL DEFAULT '',
  title               varchar(120) NOT NULL,
  details             text         NOT NULL,
  contact             varchar(200) NOT NULL DEFAULT '',
  status              text         NOT NULL DEFAULT 'pending',
  -- upheld = 维持原处理，overturned = 改了原处理；NULL = 还没判。
  decision            text         NULL,
  -- 给提交人看的答复。status 离开 pending 时必填 —— 「处理了但不告诉他结果」正是本域要消灭的形态。
  response            text         NOT NULL DEFAULT '',
  -- 管理员内部备注：与 response 分开，因为一份给人看、一份给自己人看。
  handle_note         varchar(500) NOT NULL DEFAULT '',
  handled_by          bigint       NULL REFERENCES users(id) ON DELETE SET NULL,
  handled_at          timestamptz  NULL,
  created_at          timestamptz  NOT NULL DEFAULT now(),
  updated_at          timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT ck_appeals_type     CHECK (type IN ('ban','review_reject','report_result','other')),
  CONSTRAINT ck_appeals_status   CHECK (status IN ('pending','replied','closed')),
  CONSTRAINT ck_appeals_decision CHECK (decision IS NULL OR decision IN ('upheld','overturned')),
  -- 「已答复/已关闭」必须带处理人、处理时间与答复正文；「还没判」不许带 decision。
  CONSTRAINT ck_appeals_handled  CHECK (
    (status = 'pending'  AND decision IS NULL     AND handled_by IS NULL     AND handled_at IS NULL) OR
    (status <> 'pending' AND handled_by IS NOT NULL AND handled_at IS NOT NULL AND response <> '')),
  -- 帖子审核申诉必须指向那篇帖子；其余三种事由没有对象（ref 是自由文本）。
  CONSTRAINT ck_appeals_topic    CHECK (type <> 'review_reject' OR topic_id IS NOT NULL)
);

-- C5 的幂等：**同一篇帖子只留一条未处理的申诉**（拍板 §10.10-1：重复提交返回既有状态、不再重复投递）。
-- 部分唯一索引而不是「先查后插」：并发重放时后者两条都会插进去，而幂等是端点承诺的一部分。
-- 判完之后还能再申诉一次 —— 那是新一轮的事（与 uq_reports_once 同一个取舍）。
CREATE UNIQUE INDEX uq_appeals_topic_pending ON appeals (topic_id)
  WHERE topic_id IS NOT NULL AND status = 'pending';

-- 管理端队列：?status= 过滤 + 按时间倒序翻页（同 idx_reports_queue）。
CREATE INDEX idx_appeals_queue  ON appeals (status, created_at DESC, id DESC);
-- 「我的申诉」：登录用户看自己全部（含已处理）。
CREATE INDEX idx_appeals_user   ON appeals (user_id, created_at DESC, id DESC);
-- 免登录查进展：单号 + 邮箱，两条都必须命中（no 本身已是唯一，这里只是把 email 一起带进索引）。
CREATE INDEX idx_appeals_no     ON appeals (no, email);
-- 三个外键各一条（自检：外键列上没有非部分索引就拒绝启动）。
CREATE INDEX idx_appeals_topic  ON appeals (topic_id);
CREATE INDEX idx_appeals_handle ON appeals (handled_by);
