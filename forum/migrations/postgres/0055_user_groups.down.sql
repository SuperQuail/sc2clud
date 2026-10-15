-- 0055_user_groups.down.sql —— 与 up 相反序：先拆引用方再拆被引用方。
DROP TABLE board_group_acls;
DROP TABLE user_group_members;
DROP TABLE user_groups;