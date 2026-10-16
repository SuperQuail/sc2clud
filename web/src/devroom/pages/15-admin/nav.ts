// 后台的分组导航定义。单独一个文件：组件文件里混着常量导出会被 react-refresh/only-export-components 警告。
//
// **没有 badge**：这几档原来挂着示例数字（users 12 / review 4 / reports 3 / rewards 4），而那个数字
// 没有任何真端点会去更新它 —— 界面看着正常、其实那个数永远是假的，正是本仓库要消灭的形态。
// 摘掉而不是接真件数：接真件数要给每屏加一条计数读口（后端现在没有：列表接口只给 next_cursor，
// 不给 total，拿本页条数当「待处理总数」会少报），而且导航在**每一屏**都会渲染 —— 四屏的计数查询
// 会在切进后台的第一秒一起发出去。等哪天后端给了这几个计数端点再挂回来。
export type ScreenKey =
  | 'users' | 'roles' | 'groups' | 'boards' | 'review' | 'reports' | 'rewards'
  | 'titles' | 'mail' | 'mailtpl' | 'ai' | 'settings' | 'audit' | 'diagnostics';

export const NAV: { grp: string; items: { key: ScreenKey; title: string; note: string }[] }[] = [
  {
    grp: '用户与权限',
    items: [
      { key: 'users', title: '用户管理', note: '三根状态轴 · 处罚 · 发头衔' },
      { key: 'roles', title: '角色与权限', note: '角色树 × 权限点矩阵' },
      { key: 'groups', title: '用户组', note: '建组 · 拉人入组（分区名单里按组授权）' },
    ],
  },
  {
    grp: '内容',
    items: [
      { key: 'boards', title: '分区管理', note: '排序 · 封面 · ACL 矩阵' },
      { key: 'review', title: '帖子审核', note: '待审队列 · 批量通过/拒绝' },
      { key: 'reports', title: '举报处理', note: 'open → handled / dismissed' },
    ],
  },
  {
    grp: '运营',
    items: [
      { key: 'rewards', title: '打赏核验', note: '人工核验队列' },
      { key: 'titles', title: '头衔目录', note: '建 / 改 / 归档 + 发头衔' },
      { key: 'mail', title: '发信账号', note: '优先级 · 日额度 · 测试发信' },
      { key: 'mailtpl', title: '邮件模板', note: '主题/HTML/纯文本 · 双模板编译校验 · 转义预览 · 恢复内置' },
    ],
  },
  {
    grp: '系统',
    items: [
      { key: 'ai', title: 'AI 审核', note: '判定来源 / 配置 / 密钥只写不回显 / 用量' },
      { key: 'settings', title: '站点设置', note: '文案键值 · 域名（只读）' },
      { key: 'audit', title: '审计日志', note: 'actor / action / target / detail' },
      { key: 'diagnostics', title: '自检面板', note: 'debug 开关门控的只读结果' },
    ],
  },
];

export const SCREEN_KEYS: ScreenKey[] = NAV.flatMap((g) => g.items.map((i) => i.key));