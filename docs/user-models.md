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
- 自助修改密码（`POST /api/me/password`）需提交 `oldPassword` 和新 `password`；成功后返回 `{ ok: true, token, user }`，Web 管理台保存新 token 以保持当前登录。可选的 `revokeOtherDevices` 必须是布尔值；该字段仅为兼容保留，修改密码始终撤销该账号全部会话和同步设备密钥（不论此字段的值）。

对仅存在于 `config.js` / `LX_USER_*` 的遗留用户：

- 只有连接码，没有 Web 登录密码。
- 管理台列表里会以 `source: 'config'` 展示，且通常不能用账号密码登录。

## 3. 推荐用法

1. **新部署**：用 bootstrap / `LUX_ADMIN_USER`+`LUX_ADMIN_PASSWORD` 创建管理员，再用邀请码或管理台创建托管用户；尽量不再往 `config.js` 写 `users`。
2. **兼容旧客户端**：可以暂时保留 `LX_USER_*` 或 `config.users`，但连接码必须全局唯一（与托管用户的 `lxSyncCode` 也不能撞车）。
3. **生产环境**：固定 `LUX_TOKEN_SECRET`；公网勿在未建管理员时裸暴露端口（见 README 中 bootstrap 保护说明）。

## 4. 登录令牌与设备会话

- `POST /api/auth/login` 继续返回旧字段 `token`：有效期固定为 14 天、无 `sid` 的 JWT，旧客户端无需改动。另加 `accessToken`、`refreshToken`、`accessTokenExpiresAt`（Unix 毫秒）和 `sessionId`。注册返回相同令牌字段及用户；bootstrap 仍只返回用户。
- `accessToken` 默认有效 1 小时，携带 `sid`（会话 ID）及现有 `sessionVersion`；每次鉴权同时检查账号状态、版本及会话是否存在、未撤销且未过期。旧 `token` 保持原有鉴权方式。
- 登录可传 `deviceId`、`deviceName`、`platform`；同一账号和非空 `deviceId` 再次登录会撤销旧会话。不传 `deviceId` 时，每次登录创建独立会话。
- `POST /api/auth/refresh` 接收 `{ refreshToken }`，返回新的 `accessToken`、`refreshToken`、`accessTokenExpiresAt`、`sessionId`。刷新令牌为不透明随机值，默认有效 90 天，每次刷新滑动续期。刷新会更新 `lastActiveAt`，旧刷新令牌立即失效。
- 每个会话是一条刷新令牌家族，保存 generation 和已轮换令牌的 SHA-256 哈希用于重放检测。重用已轮换令牌会撤销整个会话，连同该家族最新的刷新令牌也失效。未知、过期、已撤销或重放返回 401；沿用按 IP 的失败次数限制（达到限制后 429 `RATE_LIMITED`）。客户端应串行刷新并及时保存新令牌。
- 携带 `sid` 的令牌调用 `POST /api/auth/logout` 只撤销当前会话；旧令牌登出仍提升 `sessionVersion`，使该账号全部 JWT 失效，同时撤销全部刷新会话。
- 修改密码（包括管理员重置）或禁用账号会撤销全部会话；禁用也提升 `sessionVersion`。重新启用后需重新登录创建会话。自助改密仍返回替换用的旧格式 `token`。
- 会话保存到 `DATA_PATH/lux/sessions.json`（与 `accounts.json` 同目录），只存刷新令牌哈希，不存原文。沿用原子写入和损坏/不可读文件备份后拒绝启动策略；临时文件不参与恢复。保存时清理撤销超过 30 天或过期超过 30 天的会话。会话自助管理 API 见下文；同步设备密钥生命周期见下表。

### 会话自助管理（PR 2.3）

以下接口适用于所有已登录账号，无需管理员权限：

- `GET /api/me/sessions` 返回 `{ sessions: [...] }`，仅包含本人未撤销且未过期的会话，按 `lastActiveAt` 降序排列。字段白名单为 `id`、`deviceId`、`deviceName`、`platform`、`createdAt`、`lastActiveAt`、`current`；可选设备字段未设置时省略，不返回刷新令牌哈希或历史。`current` 表示会话 ID 与请求令牌的 `sid` 相同；旧 token 的所有条目均为 `false`。
- `DELETE /api/me/sessions/:id` 撤销本人的指定会话，返回 `{ ok: true }`。不存在或属于其他账号时统一返回 404。允许撤销当前会话（相当于该会话登出），其 accessToken、refreshToken 和绑定的同步密钥随即失效。
- `POST /api/me/sessions/revoke-others` 撤销本人除当前 `sid` 以外的全部会话，返回 `{ ok: true, revoked: <新撤销的会话数> }`，已撤销的会话不重复计数。旧 token 没有 `sid`，因此撤销本人全部会话；旧 token 本身保持原有鉴权方式。两种撤销操作均通过会话存储通知同步密钥撤销监听器，不影响其他账号。

### 同步密钥生命周期（PR 2.2）

`KeyInfo.sessionId?` 和 `origin?: 'account' | 'code'` 只存服务端，不加入 HTTP 设备列表白名单；列表不返回密钥。带 `sid` 的 Bearer token 调用 `/api/sync/key` 时绑定该会话，`origin` 为 `account`；旧 token 签发的密钥仍为 `account`，但没有 `sessionId`。连接码 `/ah` 签发的密钥为 `code`，没有 `sessionId`。复用凭据时也记录本次签发来源与会话。

| 事件 | 带 sessionId 的密钥 | 无 sessionId 的密钥（code / 旧 account / 历史记录） |
| --- | --- | --- |
| `/ah` 密钥认证、WS upgrade / 建连 | 会话须存在、未撤销且未过期，否则按未知密钥拒绝 | 保持可用，每个 clientId 每进程只警告一次，不记录密钥 |
| sid 登出、刷新令牌重放、相同 deviceId 重新登录、直接撤销会话 | 删除该会话的密钥，立即断开对应同步连接 | 保持可用 |
| 旧 token 登出 | 撤销全部会话，删除其绑定密钥并断开对应连接 | 保持可用 |
| 自助改密 / 管理员重置密码 | 全部删除并断开该用户全部同步连接 | 全部删除并断开该用户全部同步连接 |
| 禁用账号 | 全部删除并断开该用户全部同步连接 | 全部删除并断开该用户全部同步连接 |
| 重新启用账号 | 不恢复已删除密钥；旧 token 仍因 sessionVersion 失效 | 不恢复已删除密钥 |
| 自助 / 管理员重置连接码 | 保持可用 | 全部删除并断开对应同步连接 |
| 删除设备 | 删除该设备全部凭据（含别名）并断开对应连接 | 同左 |

撤销按凭据的会话归属执行，不因历史别名属于同一展示设备而误删其他会话或旧凭据；保留凭据的同步基线继续可用。会话存储通过注入回调通知服务端，账号层不导入服务端或用户模块。

**兼容性 / PR 说明：legacy keys keep working with a warning。** 现有无会话密钥无需迁移或重新配对，除非执行上述明确撤销操作；mobile 与 server 无需同时发布。服务端新增日志示例：`legacy sync key without session: <clientId> user <name>`。

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| `LUX_ACCESS_TOKEN_TTL_SECONDS` | `3600` | 新 accessToken 有效秒数 |
| `LUX_REFRESH_TOKEN_TTL_DAYS` | `90` | refreshToken 滑动有效天数 |

TTL 必须是有限正数，否则使用默认值；不影响旧 `token` 的 14 天有效期。`LUX_TOKEN_SECRET` 继续用于签名两类 JWT。

## 5. 服务发现与邀请码

`GET /api/server-info` 无需鉴权，响应带 `Cache-Control: no-store`：

```json
{
  "name": "Lux Music Sync Server",
  "version": "0.0.1",
  "packageVersion": "0.0.1",
  "minClientVersion": null,
  "publicUrl": null,
  "registration": { "inviteOnly": true, "enabled": true },
  "features": ["sessions", "refresh", "me-sessions", "invite-check"]
}
```

`version` 优先使用 `LUX_VERSION`，否则使用 `package.json`；`packageVersion` 始终是包版本。
现有 Docker 发布未设置 `LUX_VERSION`，但 release workflow 在构建前将发布版本写入包文件。
`minClientVersion` 来自 `LUX_MIN_CLIENT_VERSION`，未设置时为 `null`。
`publicUrl` 来自 `LUX_PUBLIC_URL`，未设置或不是无末尾斜杠的 HTTP(S) 基址时为 `null`（非法值会警告）；配置方法见 [fnOS 部署指南](deploy-fnos.md)。
`enabled` 表示邀请码注册端点可用，不代表当前一定有可用邀请码。服务端不报告 HTTPS 状态，客户端自行判断。

`GET /api/auth/invite/check?inviteCode=...` 或 `POST /api/auth/invite/check` JSON
`{ "inviteCode": "..." }` 无需鉴权，成功返回
`{ valid: true, inviterName, role, expiresAt }`；`inviterName` 为邀请者 displayName 或 username，
邀请者不存在时为 `null`；无有效期时 `expiresAt` 为 `null`，否则为 Unix 毫秒。
检查不消耗次数。不存在返回 404，禁用、过期、用尽返回 410；失败按 IP 使用现有鉴权限流。

`POST /api/auth/register` 继续接收 `inviteCode`、`username`、`password`、可选 `displayName`，
并支持与登录相同的设备字段。成功返回用户、旧 `token` 及 access/refresh 会话字段；
创建用户和消耗邀请次数在密码哈希完成后同步校验、一次保存，防止并发超用。
错误保留原有 message，增加机器可读 code，详见 [api-errors.md](./api-errors.md)。

## 6. 相关代码

- `src/account/store.ts`：`getSyncUsers()` / `refreshGlobalUsers()`
- `src/index.ts`：启动时 `initAccountStore` 后覆盖 `global.lx.config.users`
- `src/server/auth.ts`：`/ah` 连接码鉴权
- `docs/sync-server-mobile-flow.md`：同步协议与 Lux 模式边界
