-- 0002_accounts down：逆序删。users 先删（它引用 images/roles），再删被引用的表。
DROP TABLE users;
DROP TABLE default_avatars;
DROP TABLE images;
DROP TABLE role_permissions;
DROP TABLE permissions;
DROP TABLE roles;
