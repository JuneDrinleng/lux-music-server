# 双用户模型说明（config.users ↔ accounts.json）

Lux Music Sync Server 同时存在两套「用户」概念。它们职责不同，不要混用密码字段。

## 1. 总览

| 维度 | LX 连接码用户 | Lux 托管账号 |
| --- | --- | --- |
| 存储 | `config.js` / `LX_USER_*` env → 合并进 `global.lx.config.users` | `data/lux/accounts.json` |
| 身份字段 | `name` + `password`（语义是**连接码**，不是登录密码） | `username` + `loginPasswordHash` + `lxSyncCode` |
| 用途 | 上游 LX Music 客户端 `/ah` 连接码鉴权 | Web 管理台 / Lux 账号密码登录、邀请码注册 |
| 客户端入口 | 输入同步地址 + 连接码 | `/api/auth/login` 等，再走同步 Key 流程 |

运行时，服务端会把托管账号投影成同步用户视图：

```text
accounts.json (managed users, status=active)
        │
        ▼  AccountStore.getSyncUsers()
global.lx.config.users  ←── 还可能含 config.js / LX_USER_* 遗留用户
        │
        ▼
/ah、WebSocket 同步（连接码 = password / lxSyncCode）
```

**同步协议的单一真相源**是 `global.lx.config.users`（每次账户变更后由 `AccountStore` 刷新）。  
**Web 账号与权限的单一真相源**是 `data/lux/accounts.json`。

## 2. 字段对照

对托管用户：

- **登录密码**：只存在于 `loginPasswordHash`，用于 `POST /api/auth/login`。
- **连接码（lxSyncCode）**：投影为 `config.users[].password`，用于 LX 客户端 `/ah`。
- 管理台「查看/重置连接码」改的是 `lxSyncCode`，不会改登录密码。
- 改登录密码会 `sessionVersion++`，使已有 JWT 失效；重置连接码只影响同步鉴权。

对仅存在于 `config.js` / `LX_USER_*` 的遗留用户：

- 只有连接码，没有 Web 登录密码。
- 管理台列表里会以 `source: 'config'` 展示，且通常不能用账号密码登录。

## 3. 推荐用法

1. **新部署**：用 bootstrap / `LUX_ADMIN_USER`+`LUX_ADMIN_PASSWORD` 创建管理员，再用邀请码或管理台创建托管用户；尽量不再往 `config.js` 写 `users`。
2. **兼容旧客户端**：可以暂时保留 `LX_USER_*` 或 `config.users`，但连接码必须全局唯一（与托管用户的 `lxSyncCode` 也不能撞车）。
3. **生产环境**：固定 `LUX_TOKEN_SECRET`；公网勿在未建管理员时裸暴露端口（见 README 中 bootstrap 保护说明）。

## 4. 相关代码

- `src/account/store.ts`：`getSyncUsers()` / `refreshGlobalUsers()`
- `src/index.ts`：启动时 `initAccountStore` 后覆盖 `global.lx.config.users`
- `src/server/auth.ts`：`/ah` 连接码鉴权
- `docs/sync-server-mobile-flow.md`：同步协议与 Lux 模式边界
