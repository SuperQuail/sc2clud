import { assetUrl } from '@/lib/url';
import type { Conversation, Peer } from './types';

// 页面内 mock（设计验证页：不 fetch）。头像用 public/art 里现有的图 + 无图时走 UserAvatar 的首字兜底
// （同一个人每次同色），所以 10 个人不会看起来像一个人。
const A = (f: string) => assetUrl(f);

// 名字与 handle 一律取自 完全重构/DevRoom-假数据规范.md 的统一名单（兵种名 + demo- 前缀）。
// DevRoom 是公开部署、无鉴权，mock 会进 bundle —— 这里不许出现真实社区成员。
// 名单里长短名都有，正好用来验证「名字长了会不会把会话行撑破」。
export const ME: Peer = { handle: 'demo-admin', nickname: '示范管理员', avatar: A('miyin-portrait-320.webp') };

const MARINE: Peer = { handle: 'demo-marine', nickname: '陆战队员', avatar: A('miyin-chibi-160.webp') };
const ZEALOT: Peer = { handle: 'demo-zealot', nickname: '狂热者', avatar: A('miyin-wink-260.webp') };
// 头像原来是 miyin-cry-240.webp：这个文件 HTTP 200 但解不开（naturalWidth=0），顺手换成能用的
const HYDRALISK: Peer = { handle: 'demo-hydralisk', nickname: '刺蛇', avatar: A('miyin/smile-160.webp') };
const QUEEN: Peer = { handle: 'demo-queen', nickname: '虫后' };
const SCIENCE: Peer = { handle: 'demo-sciencevessel', nickname: '科学球' };
const GHOST: Peer = { handle: 'demo-ghost', nickname: '幽灵特工' };
const MEDIVAC: Peer = { handle: 'demo-medivac', nickname: '医疗兵' };
const MUTALISK: Peer = { handle: 'demo-mutalisk', nickname: '飞龙' };
const INFESTOR: Peer = { handle: 'demo-infestor', nickname: '感染虫' };

/** 可搜索的聊天对象（选人面板用）。会话列表里的每个人都必须在这里，否则「发私信」找不到人。 */
export const DIRECTORY: Peer[] = [MARINE, ZEALOT, HYDRALISK, QUEEN, SCIENCE, GHOST, MEDIVAC, MUTALISK, INFESTOR];

export const CONVERSATIONS: Conversation[] = [
  {
    peer: MARINE,
    summary: '谢谢关注啦，祝你天天开心哦！',
    lastAt: '今天 11:05',
    unread: 2,
    messages: [
      {
        id: 'ci-1',
        from: 'other',
        nickname: MARINE.nickname,
        avatar: MARINE.avatar,
        html: '谢谢关注啦，祝你天天开心哦！我们每个人都是最棒的，不用担心其他，开心是最重要的（￣▽￣）',
        time: '今天 11:02',
        note: '此条消息为自动回复',
      },
      { id: 'ci-2', from: 'me', nickname: ME.nickname, avatar: ME.avatar, html: '好，回头把第三章的地图发你看下，帮我提提意见。', time: '今天 11:05' },
    ],
  },
  {
    peer: ZEALOT,
    summary: '第十一张图我也卡了三天……',
    lastAt: '今天 09:41',
    unread: 1,
    messages: [
      { id: 'qi-1', from: 'me', nickname: ME.nickname, avatar: ME.avatar, html: '你那篇攻略里第三章的触发点写得挺准的，学到了。', time: '昨天 22:10' },
      { id: 'qi-2', from: 'other', nickname: ZEALOT.nickname, avatar: ZEALOT.avatar, html: '第十一张图我也卡了三天，菌毯铺得太快了，后来带两个工程车才过。', time: '今天 09:41' },
    ],
  },
  {
    peer: HYDRALISK,
    summary: '地图包我周五前整理好发你',
    lastAt: '昨天 20:15',
    unread: 0,
    messages: [
      { id: 'li-1', from: 'other', nickname: HYDRALISK.nickname, avatar: HYDRALISK.avatar, html: '地图包我周五前整理好发你，里面带上我改过的 GameStrings。', time: '昨天 20:15' },
      { id: 'li-2', from: 'me', nickname: ME.nickname, avatar: ME.avatar, html: '收到，多谢！顺便问下能不能把封面也一起打包。', time: '昨天 20:20' },
    ],
  },
  {
    peer: QUEEN,
    summary: '好的，那就按这个方案改',
    lastAt: '昨天 15:02',
    unread: 0,
    messages: [
      { id: 'ch-1', from: 'me', nickname: ME.nickname, avatar: ME.avatar, html: '第二章的空投提示我改成了「三波，每波 3 个运输机」。', time: '昨天 14:58' },
      { id: 'ch-2', from: 'other', nickname: QUEEN.nickname, avatar: QUEEN.avatar, html: '好的，那就按这个方案改。', time: '昨天 15:02' },
    ],
  },
  {
    peer: SCIENCE,
    summary: '那个 MOD 包我下了，能跑',
    lastAt: '10 月 11 日',
    unread: 0,
    messages: [
      { id: 'bi-1', from: 'other', nickname: SCIENCE.nickname, avatar: SCIENCE.avatar, html: '那个 MOD 包我下了，能跑，谢谢！', time: '10 月 11 日' },
      { id: 'bi-2', from: 'me', nickname: ME.nickname, avatar: ME.avatar, html: '有问题随时说。', time: '10 月 11 日' },
    ],
  },
  {
    peer: GHOST,
    summary: '明天开黑吗',
    lastAt: '10 月 10 日',
    unread: 0,
    messages: [
      { id: 'yu-1', from: 'other', nickname: GHOST.nickname, avatar: GHOST.avatar, html: '明天开黑吗？我这边三个人。', time: '10 月 10 日' },
    ],
  },
  {
    peer: MEDIVAC,
    summary: '收到，已加进待办',
    lastAt: '10 月 9 日',
    unread: 0,
    messages: [
      { id: 'ta-1', from: 'me', nickname: ME.nickname, avatar: ME.avatar, html: '启动器下载页在 4K 屏上按钮会被挤出可视区，你那边能复现吗？', time: '10 月 9 日' },
      { id: 'ta-2', from: 'other', nickname: MEDIVAC.nickname, avatar: MEDIVAC.avatar, html: '收到，已加进待办。', time: '10 月 9 日' },
    ],
  },
  {
    peer: MUTALISK,
    summary: '那我先不改了，等你确认',
    lastAt: '10 月 8 日',
    unread: 0,
    messages: [
      { id: 'xi-1', from: 'other', nickname: MUTALISK.nickname, avatar: MUTALISK.avatar, html: '那我先不改了，等你确认。', time: '10 月 8 日' },
    ],
  },
];
