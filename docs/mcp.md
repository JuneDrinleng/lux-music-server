# MCP：连接 AI 助手 / Connect AI assistants

端点为 `https://lux.example.com/mcp`，使用 **Streamable HTTP**（POST JSON-RPC、GET SSE、DELETE 结束会话），与管理台、同步 WS 共用服务端口。

登录 `/admin` →「MCP 访问令牌」→「新建令牌」，选择名称、最小所需权限与有效期，生成后复制令牌（仅显示一次）。在客户端环境中设置 `LUX_MCP_TOKEN`，不要将真实令牌提交到仓库。吊销／过期令牌在下一次请求即失效，登录会话令牌不能替代 PAT。

每次请求均需 `Authorization: Bearer <PAT>`。缺失或无效返回 HTTP 401，含 `WWW-Authenticate: Bearer realm="lux-music", error="invalid_token"`；无需 OAuth discovery。工具权限不足返回 `isError` 及缺少的 scope。

## 客户端配置

以下将示例域名替换为实际地址。

### Claude Code

```bash
claude mcp add --transport http lux-music https://lux.example.com/mcp --header "Authorization: Bearer ${LUX_MCP_TOKEN}"
```

项目 `.mcp.json`：

```json
{
  "mcpServers": {
    "lux-music": {
      "type": "http",
      "url": "https://lux.example.com/mcp",
      "headers": { "Authorization": "Bearer ${LUX_MCP_TOKEN}" }
    }
  }
}
```

### Codex CLI

在 `~/.codex/config.toml` 配置，启动 CLI 前设置环境变量：

```toml
[mcp_servers.lux-music]
url = "https://lux.example.com/mcp"
bearer_token_env_var = "LUX_MCP_TOKEN"
```

### Cursor

在 Cursor MCP 设置／`.cursor/mcp.json` 配置 `mcpServers.lux-music.url` 和 `headers.Authorization`。以下占位符需替换为令牌；含密钥的文件不要提交：

```json
{
  "mcpServers": {
    "lux-music": {
      "url": "https://lux.example.com/mcp",
      "headers": { "Authorization": "Bearer <PAT>" }
    }
  }
}
```

### Grok Bot

在远程 MCP 配置填写 URL `https://lux.example.com/mcp`，添加请求头 `Authorization: Bearer <PAT>`，选择 Streamable HTTP。密钥应放入 Bot 的私密凭据设置。

## 工具与权限

结果为 JSON 文本，失败含 `isError`。每次工具调用记录到令牌活动；不记录参数／歌曲内容。

| 工具 | 参数 | scope |
| --- | --- | --- |
| `get_listening_history` | `from?`, `to?`, `limit?`, `cursor?` | `history:read` |
| `get_top_tracks` | `from?`, `to?`, `limit?` | `history:read` |
| `list_playlists` | `{}` | `playlist:read` |
| `get_playlist` | `playlistId`, `offset?`, `limit?` | `playlist:read` |
| `create_playlist` | `name`, `songs?` | `playlist:write` |
| `add_songs_to_playlist` | `playlistId`, `songs` | `playlist:write` |

`from/to` 为 ISO 时间或毫秒时间戳字符串；`limit/offset` 为整数。默认／最大 limit：历史 50/200、排行 20/100、歌单歌曲 50/200。历史 cursor 为上次返回的 `nextCursor`。歌单名去除首尾空格后为 1–60 字符。

每批最多 500 首歌曲。沿用数据 API 的在线歌曲格式：必填 `id`（非空）、`name`、`singer`、`source`（`kw/kg/tx/wy/mg`）、`meta`（对象）；可选 `interval` 为字符串。其他歌曲字段保留，`meta.toggleMusicInfo` 丢弃。写操作同步到该用户在线设备。当前服务端没有歌曲搜索设施，因此不提供 `search_songs`。

## 会话、代理与 PassNAT

初始化返回 `Mcp-Session-Id`，SDK 客户端自动在后续请求携带。会话绑定初始化的用户与令牌，不可换用另一枚令牌。空闲 30 分钟后关闭（每分钟清理，下一请求也检查）；服务重启后客户端需重新初始化。DELETE `/mcp` 结束会话。`/mcp` 与 `/api/v1` 共用每枚令牌每分钟 60 次 HTTP 请求限额，包括初始化及流连接请求。

设置 `LUX_PUBLIC_URL=https://lux.example.com`。存在 `Origin` 时仅允许该公开地址的 origin 或 `localhost/127.0.0.1` 的 HTTP(S) origin；无 Origin 的 CLI 请求可用。

PassNAT HTTPS 隧道指向同一 HTTP 服务端口。SSE 必须及时逐段转发；服务发送 `X-Accel-Buffering: no`、`Cache-Control: no-cache`。Nginx 配置 `proxy_buffering off`、`proxy_http_version 1.1`、足够长的 `proxy_read_timeout`（至少 300 秒），并保留 Authorization、Mcp-Session-Id 和 MCP-Protocol-Version 请求头。多层代理／PassNAT 每一层都需检查缓冲与空闲超时。使用单实例；多实例没有共享会话。

外网验证应使用 SDK 客户端完成初始化、列工具与调用，并确认 GET SSE 保持连接、响应没有积攒后批量到达；仅 `/hello` 成功不能证明 SSE 正常。部署步骤见 [fnOS 指南](deploy-fnos.md)。
