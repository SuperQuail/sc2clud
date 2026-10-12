import Pager from '@jetbrains/ring-ui-built/components/pager/pager';

// 分页控件（我们的子控件，包 Ring 的 Pager）。
// **为什么要有这一层**：Ring 的 Pager 默认文案是英文（Previous / Next page / Last page / N per page），
// 中文界面必须传文案——指望每个调用方都记得传，迟早会漏（这是产品级缺陷，不是风格问题）。
// 所以在这里写死中文默认值，调用方只给数据和回调；要覆盖就显式传 labels。
// 顺带开启 modern 的两项：显示总数（openTotal）与「加载更多」模式（loader）。
export type PagerLabels = {
  perPage: string;
  firstPage: string;
  lastPage: string;
  nextPage: string;
  previousPage: string;
};

const ZH: PagerLabels = {
  perPage: '条 / 页',
  firstPage: '第一页',
  lastPage: '最后一页',
  nextPage: '下一页',
  previousPage: '上一页',
};

export function AppPager({
  total,
  currentPage,
  pageSize,
  pageSizes = [20, 50, 100],
  showTotal = true,
  labels,
  onPageChange,
  onPageSizeChange,
}: {
  total: number;
  currentPage: number;
  pageSize: number;
  pageSizes?: readonly number[];
  /** 显示「共 N 条」（Ring 从 7.x 起自带） */
  showTotal?: boolean;
  /** 覆盖中文文案（默认已经是中文，一般不用传） */
  labels?: Partial<PagerLabels>;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}) {
  const t = { ...ZH, ...labels };
  return (
    <Pager
      total={total}
      currentPage={currentPage}
      pageSize={pageSize}
      pageSizes={pageSizes}
      openTotal={showTotal}
      // 公开入口是 translations（那 5 个字符串是 PagerTranslations 的成员，不是组件 props）
      translations={t}
      onPageChange={(p) => onPageChange(p)}
      onPageSizeChange={onPageSizeChange}
    />
  );
}
