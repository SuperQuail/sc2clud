// mock 数据的统一出口。页面只从这里 import，方便以后整体替换成真接口（features/<域>/api.ts）。
export * from './core';
export * from './perms';
export * from './roles';
export * from './users';
export * from './content';
export * from './ops';
export * from './system';
