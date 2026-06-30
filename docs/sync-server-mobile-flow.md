# lux-music-server 与 lux-music-mobile 同步交互笔记

本文记录当前同步服务端与移动端的既有交互流程，并说明 Fastify 重构后的兼容边界。后续新增 Lux 账号密码模式时，应以本文为基准，避免破坏现有 LX 连接码同步协议。

## 1. 服务端启动流程

服务端入口是 `src/index.ts`。

启动时主要步骤：

1. 读取环境变量：`PORT`、`BIND_IP`、`CONFIG_PATH`、`DATA_PATH`、`LOG_PATH`、`PROXY_HEADER`、`MAX_SNAPSHOT_NUM`、`LIST_ADD_MUSIC_LOCATION_TYPE`、`LX_USER_*`。
2. 初始化 `global.lx`：
   - `logPath`
   - `dataPath`
   - `userPath`
   - `config`
3. 读取默认 `config.js`，并按需读取 `CONFIG_PATH`。
4. 将 `LX_USER_*` 环境变量转换成同步用户。
5. 校验用户名和连接码不能重复。
6. 创建日志目录、数据目录、用户目录。
7. 初始化日志、模块事件、数据迁移。
8. 调用 `startServer(port, bindIP)` 启动 HTTP 与 WebSocket 服务。

当前同步用户仍以 `global.lx.config.users` 为核心视图：

```ts
interface UserConfig {
  name: string
  password: string // 当前语义是 LX 连接码
  dataPath: string
  maxSnapshotNum?: number
  'list.addMusicLocationType'?: 'top' | 'bottom'
}
```

## 2. 服务端 HTTP 端点

兼容同步端点必须保持不变：

| 端点 | 用途 | 响应 |
| --- | --- | --- |
| `GET /hello` | 移动端探测同步服务和协议版本 | `SYNC_CODE.helloMsg`，例如 `Hello~::^-^::~v4~` |
| `GET /id` | 移动端获取服务端唯一 ID | `SYNC_CODE.idPrefix + serverId` |
| `GET /ah` | LX 连接码认证或已授权设备认证 | 成功时返回加密认证结果，失败时返回认证错误 |
| WebSocket `/socket?i=&t=` | 建立同步 RPC 通道 | upgrade 成功后进入同步流程 |

Fastify 重构后，这些端点由 `src/server/app.ts` 注册，但外部请求路径、参数和响应格式不变。

## 3. LX 连接码首次认证

移动端实现位置：

- `lux-music-mobile/src/plugins/sync/client/auth.ts`

服务端实现位置：

- `lux-music-server/src/server/auth.ts`

首次认证流程：

1. 移动端请求 `/hello`，确认响应是兼容协议版本。
2. 移动端请求 `/id`，获取 `serverId`。
3. 如果本地没有该 `serverId` 对应的 `KeyInfo`，移动端需要用户输入连接码。
4. 移动端用连接码派生 AES key：
   - `toMD5(authCode).substring(0, 16)`
   - 再转换为 base64
5. 移动端生成 RSA 公私钥。
6. 移动端构造认证明文：

```text
lx-music auth::
<publicKey>
<deviceName>
lx_music_mobile
```

7. 移动端用连接码派生的 AES key 加密该明文，并将结果放到请求头 `m`，请求 `/ah`。
8. 服务端 `verifyByCode()` 遍历同步用户的连接码，尝试用每个连接码派生 key 解密 `m`。
9. 某个用户解密成功后，服务端创建设备信息：
   - `clientId`
   - `key`
   - `deviceName`
   - `isMobile`
   - `lastConnectDate`
10. 服务端保存设备信息到该用户的 `devices.json`，并调用 `setUserName(clientId, userName)` 建立 `clientId -> userName` 映射。
11. 服务端用移动端 RSA public key 加密返回：

```json
{
  "clientId": "...",
  "key": "...",
  "serverName": "..."
}
```

12. 移动端解密后把结果按 `serverId` 保存到本地 `@sync_auth_key`。

注意：LX 连接码模式下，移动端首次认证不发送用户名，服务端通过“哪个连接码能解密成功”判断用户。因此连接码不能重复。

## 4. 已授权设备认证

移动端本地保存过 `serverId -> KeyInfo` 后，后续连接不再要求用户输入连接码。

流程：

1. 移动端请求 `/hello`。
2. 移动端请求 `/id` 获取 `serverId`。
3. 移动端从本地读取 `KeyInfo`。
4. 移动端使用 `KeyInfo.key` 加密 `SYNC_CODE.authMsg + deviceName`。
5. 移动端请求 `/ah`，携带：
   - header `i`: `clientId`
   - header `m`: 加密消息
6. 服务端 `verifyByKey()` 根据 `clientId` 找用户名和设备 key。
7. 服务端解密并验证消息以 `SYNC_CODE.authMsg` 开头。
8. 成功后返回用设备 key 加密的 hello 文本。

该流程是现有移动端自动重连的基础，不能破坏。

## 5. WebSocket 连接认证

移动端实现位置：

- `lux-music-mobile/src/plugins/sync/client/client.ts`

服务端实现位置：

- `lux-music-server/src/server/server.ts`
- `lux-music-server/src/server/auth.ts`

认证成功拿到 `KeyInfo` 后，移动端连接：

```text
ws(s)://<host>/socket?i=<clientId>&t=<aesEncrypt('lx-music connect', key)>
```

服务端 upgrade 时：

1. 读取 query 参数 `i` 和 `t`。
2. 根据 `i` 找到用户名和设备 key。
3. 用设备 key 解密 `t`。
4. 解密结果必须等于 `SYNC_CODE.msgConnect`。
5. 通过后调用 `wss.handleUpgrade()`，进入 WebSocket connection。

Fastify 重构后，WebSocket 仍挂在 Fastify 底层 Node server 的 `upgrade` 事件上，认证参数和逻辑不变。

## 6. WebSocket 建连后的服务端流程

服务端 `handleConnection()` 主要步骤：

1. 从 WebSocket request query 读取 `clientId`。
2. 通过 `getUserName(clientId)` 找用户名。
3. 通过 `getUserSpace(userName)` 获取用户空间。
4. 从 `UserDataManage` 读取设备 `KeyInfo`。
5. 更新设备 `lastConnectDate`。
6. 将 `socket.keyInfo` 和 `socket.userInfo` 绑定到连接。
7. 如果同一 `clientId` 已经在线，关闭旧连接。
8. 调用 `sync(socket)` 执行初始同步。
9. 设置在线设备状态，注册 close handler。

用户空间来自 `src/user/index.ts`，包含：

- `dataManage`: 设备与用户数据管理。
- `listManage`: 歌单快照和数据管理。
- `dislikeManage`: dislike 规则快照和数据管理。

## 7. message2call RPC 协议

服务端和移动端都使用 `message2call` 封装 WebSocket RPC。

服务端侧：

- `lux-music-server/src/server/server.ts`
- `lux-music-server/src/server/sync/*`
- `lux-music-server/src/modules/list/sync/*`
- `lux-music-server/src/modules/dislike/sync/*`

移动端侧：

- `lux-music-mobile/src/plugins/sync/client/client.ts`
- `lux-music-mobile/src/plugins/sync/client/sync/*`
- `lux-music-mobile/src/plugins/sync/client/modules/list/*`
- `lux-music-mobile/src/plugins/sync/client/modules/dislike/*`

服务端会调用移动端：

- `getEnabledFeatures(serverType, supportedFeatures)`
- `finished()`
- `list_sync_get_md5()`
- `list_sync_get_sync_mode()`
- `list_sync_get_list_data()`
- `list_sync_set_list_data(data)`
- `list_sync_finished()`
- `dislike_sync_get_md5()`
- `dislike_sync_get_sync_mode()`
- `dislike_sync_get_list_data()`
- `dislike_sync_set_list_data(data)`
- `dislike_sync_finished()`

移动端会调用服务端：

- `onFeatureChanged(feature)`
- `onListSyncAction(action)`
- `onDislikeSyncAction(action)`

当前 WebSocket payload 大消息会 gzip 后加 `cg_` 前缀；认证阶段仍使用 AES/RSA。公网部署仍应使用 HTTPS/WSS。

## 8. 歌单同步流程

歌单同步核心位置：

- 服务端：`lux-music-server/src/modules/list/sync/sync.ts`
- 移动端：`lux-music-mobile/src/plugins/sync/client/modules/list/handler.ts`
- 移动端本地数据：`lux-music-mobile/src/plugins/sync/listEvent.ts`

初始同步流程：

1. 服务端确认客户端启用了 `list` feature。
2. 服务端读取当前设备上次同步快照 key。
3. 如果有快照，执行基于快照的三方合并：
   - 服务端当前数据
   - 移动端当前数据
   - 上次共同快照
4. 如果没有快照，走普通同步：
   - 双方都有数据时，移动端弹出同步模式选择。
   - 仅服务端有数据时，推送到移动端。
   - 仅移动端有数据时，写入服务端。
5. 同步完成后创建或更新快照，并记录设备当前 snapshot key。

同步数据结构：

```ts
{
  defaultList: MusicInfo[],
  loveList: MusicInfo[],
  userList: Array<UserListInfo & { list: MusicInfo[] }>
}
```

`tempList` 不参与同步。

实时同步：

1. 初始同步完成后，移动端注册本地歌单事件。
2. 本地新增/删除/移动/修改歌曲或列表时，移动端调用服务端 `onListSyncAction(action)`。
3. 服务端应用 action 到内存数据，创建新快照，更新当前设备 snapshot key。
4. 服务端广播给同用户其他已 ready 设备。
5. 其他移动端应用远端 action，并避免回环发送。

## 9. dislike 同步流程

位置：

- 服务端：`lux-music-server/src/modules/dislike/*`
- 移动端：`lux-music-mobile/src/plugins/sync/client/modules/dislike/*`

dislike 与歌单同步结构类似，也使用：

- 初始同步。
- 快照三方合并。
- 实时 action 广播。

dislike 数据是字符串规则，规则内部会做 trim、小写和去重。

## 10. 移动端 UI 入口

主要入口：

- `lux-music-mobile/src/screens/Home/Vertical/Tabs/SettingsTab.tsx`

现有职责：

- 输入和保存同步地址。
- 管理同步地址历史。
- 启停同步。
- 在缺少连接码或连接码错误时弹出连接码输入框。
- 展示同步状态。
- 展示同步格式入口，目前 `lx` 可用，`lux` 是开发中提示。

App 启动自动连接：

- `lux-music-mobile/src/core/init/sync.ts`

流程：

1. 检查 `setting['sync.enable']`。
2. 读取保存的 sync host。
3. 如果没有 host，关闭 sync enable。
4. 如果有 host，调用 `connectServer(host)`。

## 11. Fastify 重构后的架构边界

Fastify 只负责 HTTP/API/Web 管理页承载；同步兼容协议保持原样。

边界约定：

- `/hello`、`/id`、`/ah` 是兼容同步 HTTP 端点。
- `/socket?i=&t=` 是兼容 WebSocket 同步端点。
- `/api/*` 是新 Lux/Web 管理 API。
- `/admin` 是新 Web 管理页面。

新增 Lux 账号密码模式时，不应该修改 WebSocket 同步协议，而是新增：

```text
POST /api/auth/login
POST /api/sync/key
```

移动端 Lux 模式先用账号密码或 token 获取 `KeyInfo`，之后继续使用现有 WebSocket 同步流程。

## 12. Lux 模式设计备注

Lux 模式与 LX 模式的差异只在“如何获取 `KeyInfo`”：

- LX 模式：连接码通过 `/ah` 换取 `KeyInfo`。
- Lux 模式：账号密码登录 `/api/auth/login`，再通过 `/api/sync/key` 获取 `KeyInfo`。

两种模式拿到 `KeyInfo` 后，都进入同一条同步通道：

```text
/socket?i=<clientId>&t=<aesEncrypt('lx-music connect', key)>
```

因此服务端 list/dislike 同步核心、快照合并、实时广播逻辑都可以复用。
