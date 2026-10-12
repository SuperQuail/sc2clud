// Lexical 的主题类。只给类名、颜色一律走令牌（gate:tokens 会盯着这里）。
export const theme = {
  paragraph: 'my-2 text-[15px] leading-relaxed text-foreground',
  heading: {
    h1: 'mt-4 mb-2 text-xl font-semibold text-foreground',
    h2: 'mt-3 mb-2 text-lg font-semibold text-foreground',
    h3: 'mt-3 mb-1 text-base font-semibold text-foreground',
  },
  quote: 'my-2 border-l-2 border-border pl-3 text-muted-foreground italic',
  list: {
    ul: 'my-2 ml-5 list-disc text-foreground',
    ol: 'my-2 ml-5 list-decimal text-foreground',
    listitem: 'my-0.5',
  },
  link: 'text-primary underline underline-offset-2',
  text: {
    bold: 'font-semibold',
    italic: 'italic',
    code: 'rounded bg-muted px-1 font-mono text-[13px]',
    underline: 'underline',
    strikethrough: 'line-through',
  },
} as const;
