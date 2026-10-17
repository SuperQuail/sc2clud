// 运行期前缀：唯一来源是文档的 <base href>（由 Go 壳按实例注入 '/' 或 '/dev/'）。
// 不要用 Vite 的 import.meta.env.BASE_URL——那是构建期常量，同一份产物要跑两个前缀。
function readBase(): string {
  try {
    const path = new URL(document.baseURI).pathname;
    if (path.endsWith('/')) return path;
    // 文档 URL 是**文件**时（例如本地把 devroom 当 /devroom.html 提供），
    // 基址是它所在的目录，而不是「文件名 + 斜杠」——否则图片会变成 /devroom.html/art/x 而 404。
    const cut = path.lastIndexOf('/');
    return cut < 0 ? '/' : path.slice(0, cut + 1);
  } catch {
    return '/'; // jsdom 或异常环境下退化为根
  }
}

export const BASE: string = readBase();

// 去掉尾部斜杠给 Router 当 basename（'/' → '/'，'/dev/' → '/dev'）
export const ROUTER_BASENAME: string = BASE === '/' ? '/' : BASE.slice(0, -1);
