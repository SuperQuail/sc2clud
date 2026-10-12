// 方向 D / 现代社区：两个变体共用的类型、假数据、假接口与翻页 hook。
// 字段名照抄 完全重构/设计需求-分区页.md §D（与后端 §21 契约一致）：换掉 fakeTopics 即可接真接口。
// 这里没有 fetch（ESLint no-restricted-globals 会拦），数据全在内存里。
import { useCallback, useEffect, useRef, useState } from 'react';

export type TopicKind = 'discussion' | 'resource' | 'repost';
export type Author = { handle: string; nickname: string; avatar: string };
export type Board = {
  name: string;
  slug: string;
  description: string;
  cover: string;
  topic_count: number;
  post_count: number;
  member_count: number;
  today_count: number;
  joined: boolean;
};
export type Topic = {
  id: string;
  title: string;
  excerpt: string;
  kind: TopicKind;
  author: Author;
  reply_count: number;
  like_count: number;
  view_count: number;
  last_reply_at: string;
  created_at: string;
  cover?: string;
  pinned?: boolean;
  featured?: boolean;
};

/* ── 分区（真实项目来自 GET /api/v1/boards） ─────────────────────────────── */

export const BOARDS: Board[] = [
  { name: '自制战役', slug: 'campaign', description: '玩家自制的战役、关卡与剧情 Mod：发布、试玩、互相找 bug。', cover: 'campaign', topic_count: 1284, post_count: 18420, member_count: 5231, today_count: 24, joined: true },
  { name: '对战与平衡', slug: 'melee', description: '天梯环境、战术复盘与平衡性讨论；发帖请带上录像编号。', cover: 'melee', topic_count: 967, post_count: 15230, member_count: 4108, today_count: 17, joined: false },
  { name: '银河编辑器', slug: 'galaxy', description: '触发器、数据编辑器与 Galaxy 脚本：能复现的问题都欢迎。', cover: 'galaxy', topic_count: 2103, post_count: 26890, member_count: 6320, today_count: 31, joined: true },
  { name: '工具与启动器', slug: 'tool', description: '启动器、打包工具、模型转换与插件；发布贴请写清系统与版本。', cover: 'tool', topic_count: 512, post_count: 6420, member_count: 2410, today_count: 8, joined: false },
  { name: '地图美术', slug: 'art', description: '地形、贴图、模型与过场运镜；素材转载必须带授权说明。', cover: 'art', topic_count: 734, post_count: 9110, member_count: 3325, today_count: 12, joined: false },
  { name: '录像复盘', slug: 'replay', description: '把录像拆成时间轴，一场一场讲清楚转折点在哪。', cover: 'replay', topic_count: 388, post_count: 5240, member_count: 1980, today_count: 6, joined: false },
  { name: '提问求助', slug: 'help', description: '装不上、跑不起来、脚本报错：先搜，再问，附上报错原文。', cover: 'help', topic_count: 3210, post_count: 31240, member_count: 7860, today_count: 42, joined: true },
  { name: '公告与活动', slug: 'news', description: '站务公告、版本更新与社区活动；只读为主。', cover: 'news', topic_count: 96, post_count: 1420, member_count: 9120, today_count: 3, joined: false },
];

/* ── 主题（真实项目来自 GET /api/v1/boards/:slug/topics?cursor=…） ───────── */

const AUTHORS: Author[] = [
  { handle: 'tangtian', nickname: '唐天', avatar: '' },
  { handle: 'kirinDev', nickname: '麒麟工坊', avatar: '' },
  { handle: 'zergling42', nickname: '小狗四十二', avatar: '' },
  { handle: 'mapcraft', nickname: '地图工房', avatar: '' },
  { handle: 'launcher', nickname: '启动器维护组', avatar: '' },
  { handle: 'yueying', nickname: '月影', avatar: '' },
  { handle: 'vibe', nickname: 'Vibe', avatar: '' },
  { handle: 'observer', nickname: '旁观者', avatar: '' },
  { handle: 'anan', nickname: '阿南', avatar: '' },
];

type Seed = { kind: TopicKind; title: string; excerpt: string; cover: boolean; featured?: boolean };
const SEEDS: Seed[] = [
  { kind: 'resource', title: '《星海余烬》完整战役 v2.4：九关全语音，含分支结局与存档继承', excerpt: '这一版把第七关的演出整个重做了，另外补上两条支线的结局动画。存档继承终于能用，旧版本的通关记录会直接读进来。', cover: true },
  { kind: 'discussion', title: 'actor 事件里 Send 的求值顺序到底怎么定的？文档没写清楚的那一段', excerpt: '同一个 CActorModel 上挂了三条 On Terms，实测顺序和 XML 里的书写顺序并不一致。有人摸清过规则吗，还是只能靠 parent 链兜底。', cover: false },
  { kind: 'discussion', title: '4.11 之后 ZvT 的中期节奏被拉长了吗：从天梯前 200 的录像里看到的趋势', excerpt: '抽了最近 400 场高分段对局，中期交火时间点整体后移约 40 秒。是地图池的原因，还是虫族经济改动带来的。', cover: true, featured: true },
  { kind: 'resource', title: 'SC2clud 启动器 0.9.7：多实例共存、地图包校验、离线模式', excerpt: '这次加了地图包哈希校验，坏包在启动前就会报出来，不会再进游戏才崩。多实例共存要给每个实例单独指定数据目录。', cover: true },
  { kind: 'repost', title: '转载：一套可商用的科幻地面贴图（含 4K 与法线），作者已授权', excerpt: '原帖在作者的个人站，已取得书面授权。包内 62 张贴图，全部 CC-BY 4.0，署名要求写在 LICENSE 里。', cover: true },
  { kind: 'discussion', title: 'Galaxy 里做对象池值得吗：实测 2000 个单位下的行为差别', excerpt: '结论是：在 2 核机器上不值得，GC 压力比对象复用省下来的那点更小。附压测脚本与数据表。', cover: false },
  { kind: 'discussion', title: '给新人的一条路线：从改一个触发器到做完一关要多久', excerpt: '把自己两年前踩过的坑按顺序列了一遍，按这个顺序走大概能省掉一半时间。欢迎补充。', cover: false, featured: true },
  { kind: 'resource', title: '触发器模板库 v2：37 个可直接拖进地图的 AI 波次模块', excerpt: '每个模块都带注释与依赖说明，复制进地图后只要改三个常量。附一段 6 分钟的配置视频。', cover: true },
  { kind: 'repost', title: '转载：官方 Mod 工具链 2026 路线图要点翻译', excerpt: '原文发在官方论坛，这里只翻译与地图作者相关的那几节，附术语对照表。', cover: false },
  { kind: 'resource', title: '中文语音包（男声 / 女声）与字幕对齐脚本', excerpt: '语音按关卡切好，字幕时间轴对齐到毫秒。脚本可以把新录的语音批量切分并生成清单。', cover: true },
  { kind: 'discussion', title: '地图里 40 个单位以上就掉帧，有哪些低成本的优化手段？', excerpt: '已经关掉了大部分装饰物与雾效，帧数还是从 60 掉到 38。想先确认瓶颈是在单位数量还是模型面数。', cover: false },
  { kind: 'discussion', title: 'Blender 导出 m3 之后贴图全黑，是哪一步漏了？', excerpt: '材质节点用的是 Principled BSDF，导出器没有报错。换一台机器导出同样变黑，怀疑是贴图路径大小写。', cover: false },
  { kind: 'resource', title: '战役过场动画模板：运镜 + 字幕 + 跳过逻辑都接好了', excerpt: '含三段运镜示例与可跳过的字幕轨，把摄像机换成自己的就能用。', cover: true },
  { kind: 'discussion', title: '触发器里做存档兼容：老存档读新地图会不会直接崩？', excerpt: '改了一版科技树之后，老存档进图会卡在加载界面。有人处理过这类兼容吗，还是只能让玩家重开。', cover: false },
  { kind: 'resource', title: '地形笔刷与装饰物包：雪原 / 熔岩 / 都市三套', excerpt: '三套共 148 个装饰物，全部按原有风格绘制，坐标已对齐网格，可直接刷。', cover: true },
  { kind: 'repost', title: '转载：韩国社区的自定义 UI 框架，附中文注释补丁', excerpt: '框架本身是 MIT，补丁只翻译注释不改逻辑。已联系作者确认可以转载。', cover: false },
  { kind: 'discussion', title: '一场 42 分钟的 TvP：从被压到翻盘，关键的三次换家', excerpt: '录像编号与时间轴都在正文里，第 18 分钟那次空投是全场转折。', cover: false },
  { kind: 'resource', title: '地图打包与自动上传脚本（Windows / macOS 都可用）', excerpt: '一条命令完成打包、校验、上传与发帖草稿，CI 里也能跑。', cover: true },
  { kind: 'discussion', title: '为什么同样的触发器在多人模式下不触发？', excerpt: '单人测试一切正常，进了对战房间之后事件完全收不到，是不是初始化时机的问题。', cover: false },
  { kind: 'resource', title: '战役地图亮度与雾效预设包（11 个预置，含沙漠与虚空夜）', excerpt: '每个预置都标了适合的地形主题与建议曝光值，直接替换数据表里的三项即可。', cover: true },
];

const DAY = 86_400_000;
/** 固定基准时间：相对时间不在渲染里读时钟，避免每帧重排。 */
export const NOW = Date.parse('2026-10-12T12:40:00Z');

/** 分区圆点：二级栏给每个分区一个稳定的弱色标，不引入新色值。 */
export const BOARD_DOT: Record<string, string> = {
  campaign: 'bg-primary',
  melee: 'bg-destructive',
  galaxy: 'bg-primary/60',
  tool: 'bg-foreground/50',
  art: 'bg-primary/40',
  replay: 'bg-destructive/60',
  help: 'bg-foreground/30',
  news: 'bg-primary/80',
};

/** 主题类型的中文名：徽标、标签、筛选共用一份，改一处即可。 */
export const KIND_LABEL: Record<TopicKind, string> = { discussion: '讨论', resource: '资源', repost: '转载' };
const BOARD_OF: Record<TopicKind, number> = { discussion: 2, resource: 0, repost: 4 };

function build(): Topic[] {
  const out: Topic[] = [];
  for (let i = 0; i < 27; i += 1) {
    const seed = SEEDS[i % SEEDS.length];
    if (!seed) continue;
    const rep = i > SEEDS.length - 1;
    const board = BOARDS[rep ? (i * 3) % BOARDS.length : BOARD_OF[seed.kind]];
    if (!board) continue;
    const author = AUTHORS[i % AUTHORS.length];
    if (!author) continue;
    out.push({
      id: 't_' + (0x9f21 + i * 137).toString(16),
      title: seed.title,
      excerpt: seed.excerpt,
      kind: rep ? (['discussion', 'resource', 'repost'] as const)[i % 3] ?? 'discussion' : seed.kind,
      author,
      reply_count: 12 + ((i * 37) % 260),
      like_count: 4 + ((i * 23) % 140),
      view_count: 420 + ((i * 1877) % 12000),
      created_at: new Date(NOW - (1 + (i % 6)) * DAY - i * 5.4e6).toISOString(),
      last_reply_at: new Date(NOW - i * 4.7e6 - (i % 3) * 3.1e6).toISOString(),
      cover: seed.cover ? 'c' + String(i) : undefined,
      pinned: i === 1 || i === 9,
      featured: seed.featured,
    });
  }
  return out;
}

const ALL_TOPICS: Topic[] = build();

export type TopicFilter = { board: string; tag: string; q: string };
export type TopicPage = { data: Topic[]; next_cursor: string | null };

/** 假接口：形状与后端 §21.3 一致。真项目里把这里换成 api('/boards/:slug/topics')。 */
export function fakeTopics(f: TopicFilter, cursor: string | null, limit: number, fail: boolean): Promise<TopicPage> {
  const offset = cursor ? Number(cursor) : 0;
  return new Promise((resolve, reject) => {
    window.setTimeout(() => {
      if (offset === 0 && fail) {
        reject(new Error('network'));
        return;
      }
      const all = ALL_TOPICS.filter(
        (t) =>
          (f.tag === 'all' || (f.tag === 'featured' ? t.featured === true : t.kind === f.tag)) &&
          (f.q === '' || (t.title + t.excerpt).toLowerCase().includes(f.q.toLowerCase())),
      );
      resolve({
        data: all.slice(offset, offset + limit),
        next_cursor: offset + limit < all.length ? String(offset + limit) : null,
      });
    }, 420);
  });
}

/** 主题所属分区。真接口里主题会自带 board 字段；假数据用确定性公式还原，避免两份数据对不上。 */
export function boardOf(topic: Topic): Board {
  return BOARDS[BOARD_OF[topic.kind]] ?? BOARDS[0]!;
}

/** 分区内标签：类型名来自 KIND_LABEL，改一处即可同步。 */
export const TAGS_SOURCE: { key: string; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'featured', label: '精华' },
  { key: 'resource', label: KIND_LABEL.resource },
  { key: 'discussion', label: KIND_LABEL.discussion },
  { key: 'repost', label: KIND_LABEL.repost },
  { key: 'news', label: '公告' },
];

export type ListState = 'loading' | 'more' | 'ready' | 'empty' | 'error';

/** 两个变体共用的列表状态机：游标翻页 + 骨架 / 空 / 错误三态。
 *  自建的只有状态机，控件一律来自 Ring UI。 */
export function useTopicFeed(filter: TopicFilter, pageSize: number) {
  const [list, setList] = useState<Topic[]>([]);
  const [state, setState] = useState<ListState>('loading');
  const [hasMore, setHasMore] = useState(false);
  const [fail, setFail] = useState(false);
  const [nonce, setNonce] = useState(0);
  const cursor = useRef<string | null>(null);
  const busy = useRef(false);
  const more = useRef(false);

  const key = filter.board + '|' + filter.tag + '|' + filter.q + '|' + pageSize + '|' + nonce;

  useEffect(() => {
    let live = true;
    busy.current = true;
    cursor.current = null;
    more.current = false;
    setState('loading');
    setList([]);
    fakeTopics(filter, null, pageSize, fail)
      .then((page) => {
        if (!live) return;
        cursor.current = page.next_cursor;
        setHasMore(page.next_cursor !== null);
        setList(page.data);
        setState(page.data.length === 0 ? 'empty' : 'ready');
      })
      .catch(() => {
        if (live) setState('error');
      })
      .finally(() => {
        busy.current = false;
      });
    return () => {
      live = false;
    };
    // filter 是每次渲染新造的对象：用 key 当依赖，避免无限重取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const loadMore = useCallback(() => {
    if (busy.current || cursor.current === null) return;
    busy.current = true;
    more.current = true;
    setState('more');
    fakeTopics(filter, cursor.current, pageSize, false)
      .then((page) => {
        cursor.current = page.next_cursor;
        setHasMore(page.next_cursor !== null);
        setList((prev) => prev.concat(page.data));
        setState('ready');
      })
      .catch(() => setState('error'))
      .finally(() => {
        busy.current = false;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  /** 演示开关：空态 / 错误态 / 重新加载。 */
  const retry = useCallback(() => {
    setFail(false);
    setNonce((n) => n + 1);
  }, []);
  const showEmpty = useCallback(() => {
    setFail(false);
    setNonce((n) => n + 1);
    setState('empty');
    setList([]);
    setHasMore(false);
  }, []);
  const showError = useCallback(() => {
    setFail(true);
    setNonce((n) => n + 1);
  }, []);

  return { list, state, hasMore, loadMore, retry, showEmpty, showError, more: more.current };
}

/* ── 视图开关写进 URL：?view=card|compact（可分享、可后退） ─────────────── */

export type ViewMode = 'card' | 'compact';

export function readView(): ViewMode {
  try {
    return new URLSearchParams(window.location.search).get('view') === 'compact' ? 'compact' : 'card';
  } catch {
    return 'card';
  }
}

export function writeView(view: ViewMode): void {
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('view', view);
    window.history.replaceState(null, '', url);
  } catch {
    /* 预览环境没有 history 就算了，不影响渲染 */
  }
}

/* ── 展示用的格式化（本地时区只在这里出现） ─────────────────────────────── */

const compactNumber = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 });
const wallClock = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' });

export function count(n: number): string {
  return compactNumber.format(n);
}

export function relative(iso: string, now: number = NOW): string {
  const min = Math.floor((now - Date.parse(iso)) / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return String(min) + ' 分钟前';
  if (min < 1440) return String(Math.floor(min / 60)) + ' 小时前';
  if (min < 1440 * 7) return String(Math.floor(min / 1440)) + ' 天前';
  return wallClock.format(new Date(iso));
}

/** 稳定散列：封面图案由标题决定，刷新不乱跳。 */
export function seedOf(text: string): number {
  let n = 7;
  for (let i = 0; i < text.length; i += 1) n = (n * 31 + text.charCodeAt(i)) % 100003;
  return n;
}
