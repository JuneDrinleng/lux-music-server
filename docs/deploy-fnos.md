# 飞牛 fnOS 部署（PassNAT HTTPS 隧道）

以下标有 **June 在 NAS 操作** 的步骤需在实际设备完成；仓库配置不会自动部署到 NAS。

## 1. 准备与导入

**June 在 NAS 操作：**

1. 安装 fnOS「Docker」应用，准备应用目录，例如 `/vol1/1000/docker/lux-music-server`；确认 9527 端口空闲，NAS 可拉取 Docker Hub 镜像。只运行一个实例（一起听房间保存在进程内存）。
2. 将 [docker-compose.yml](../deploy/fnos/docker-compose.yml) 和 [.env.example](../deploy/fnos/.env.example) 放入此目录，将后者复制为 `.env`。运行 `openssl rand -hex 32`，将输出填入 `LUX_TOKEN_SECRET`，替换占位符。安全保存密钥，不要提交真实 `.env`。
3. 首次部署建议同时填写 `LUX_ADMIN_USER`、`LUX_ADMIN_PASSWORD`（独立强密码）；也可留空并按下一节 bootstrap。`LUX_PUBLIC_URL` 改为实际域名，例如 `https://lux.example.com`，无末尾 `/`；隧道未准备好时留空。暂保留 `LUX_TRUST_PROXY=0`。
4. 打开「Docker」→「Compose」→ 新建／导入，选择应用目录和 Compose 文件，加载同目录 `.env`（或在界面的环境变量栏填写相同值），核对展开后的环境变量再启动。

`./data:/server/data` 是**绑定挂载**：`./data` 相对 Compose 项目目录，应落在上述应用目录内。如果界面导入时更换项目目录，务必核对或改成绝对路径，如 `/vol1/1000/docker/lux-music-server/data:/server/data`。镜像默认 `DATA_PATH=/server/data/data`、`LOG_PATH=/server/data/logs`，因此宿主机会出现 `data/data`，不是重复配置错误。

默认镜像是 `docker.io/junedrinleng/lux-music-server:latest`；开发版改为 `:dev`，GHCR 备用地址见 Compose 注释。镜像已有 `/hello` 健康检查，无需重复设置；Docker 日志按每份 10MB、最多 3 份轮转。

## 2. 首次启动与管理员

**June 在 NAS 操作：** 查看容器日志和健康状态，先从局域网访问 `http://<NAS IP>:9527/hello`、`/admin`。

- 同时设置 `LUX_ADMIN_USER`、`LUX_ADMIN_PASSWORD` 时，启动会为不存在的用户名创建管理员。成功后可清空这两项并重建容器；它们不会重置已有账号密码。
- 未设置管理员时，可在容器终端执行以下 bootstrap（先替换密码）。未配置 `LUX_BOOTSTRAP_TOKEN` 时仅容器内回环请求可用，宿主机映射端口不算回环；初始化期间先保持代理信任关闭。

```bash
node -e 'fetch("http://127.0.0.1:9527/api/auth/bootstrap", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({username:"admin",password:"REPLACE_WITH_STRONG_PASSWORD"})}).then(async r => console.log(r.status, await r.text()))'
```

远程 bootstrap 需自行给容器配置 `LUX_BOOTSTRAP_TOKEN` 并携带 `x-lux-bootstrap-token` 请求头，完成后移除该配置。创建管理员后再开放公网隧道。登录密码与 LX 连接码用途不同，见 [双用户模型](user-models.md)；登录管理台后可创建用户或邀请码。

## 3. PassNAT（帕斯内网穿透）

**June 在 NAS 操作：**

1. 在 fnOS 应用商店搜索并安装 PassNAT，登录后新增隧道；也可使用 frpc 加载 PassNAT 提供的配置。见 [PassNAT 飞牛官方教程](https://doc.passnat.com/docs/connection/fnos/)。
2. 创建 **HTTPS 隧道、源站 HTTP**，本地目标端口为 `9527`。客户端原生运行在 NAS 时通常填 `127.0.0.1:9527`；若 frpc 在容器内，`127.0.0.1` 指向 frpc 容器，需改成能访问 NAS 映射端口的地址。
3. 域名可使用 PassNAT 提供的域名；自有域名需完成 ICP 备案，在 PassNAT「域名管理」添加、按节点要求设置解析，并加入对应可用区的白名单。见 [官方域名与白名单说明](https://doc.passnat.com/docs/qa/)。
4. 申请对应域名的可信证书，将 **Apache 格式证书和私钥**保存到 NAS；隧道中填写客户端可读的**绝对路径**。frpc 容器部署时还需挂载证书目录，填写容器内路径。源站 HTTP 由 frpc `https2http` 插件转换，不需要给 Lux 配置 TLS。证书设置见 [官方 HTTPS 教程](https://doc.passnat.com/docs/app/https)，注意按期续证并更新文件。
5. 启动隧道，始终用 `https://<域名>` 访问；Lux 源站仍是 HTTP。不要用 `http://` 或节点 IP 代替 HTTPS 域名。

同步 WebSocket 与 HTTP 使用同一个 9527 端口，应通过此 HTTPS 隧道建立 WSS。**需在 NAS 实测 App 同步、空闲后重连**，确认节点支持并转发 Upgrade，超时至少 300 秒。未来 MCP 的 SSE／流式响应也需检查隧道及代理是否缓冲、是否及时逐段转发；当前没有 MCP 端点可用于验证。

### 真实 IP 与公开地址

**June 在 NAS 操作：** 检查隧道实际传入的 `X-Forwarded-For` 和源连接地址，更新 `.env` 并重建容器：

- `LUX_TRUST_PROXY` 控制 Fastify HTTP 的 `request.ip`，供 API 限流及 bootstrap 来源判断使用。默认 `0`／`false` 关闭；`1`／`true` 信任所有代理；整数 `2` 等表示信任跳数；推荐填实际可信代理 IP／CIDR，多个用逗号分隔，例如 `172.18.0.1/32,::1/128`（仅为示例，不能照抄）。非法值会警告并关闭信任。
- Compose 已设置 `PROXY_HEADER=x-forwarded-for`，保留原有 WS／`/ah` 连接码鉴权的 IP 头行为。它独立于 `LUX_TRUST_PROXY`，不会自动开启 HTTP 代理信任，也不会按 CIDR 筛选头内容；旧逻辑直接读取头部，包含多项时使用整串值。
- 确认 PassNAT/frp 正确覆盖或追加真实客户端 IP，限制源站 9527 仅供可信代理和局域网管理访问。不要把带代理信任的源站直接映射到公网，避免伪造头部绕过限流／影响 bootstrap。信任跳数须匹配链路；路径长度不固定时优先使用 CIDR。
- `LUX_PUBLIC_URL=https://<实际域名>` 在 `GET /api/server-info` 中返回 `publicUrl`，不会建立隧道或强制重定向。未设置返回 `null`；只接受无末尾 `/` 的 HTTP(S) 基址，不含账号密码、查询及片段，否则警告并忽略。这两项不是密钥，启动日志可显示。

## 4. 验证清单

**June 在 NAS／外网客户端操作：**

```bash
curl -i https://<域名>/hello
# HTTP 200，正文 Hello~::^-^::~v4~
curl https://<域名>/api/server-info
# 检查 name、version、publicUrl（应为实际 HTTPS 地址）
```

- 浏览器打开 `https://<域名>/admin`，证书可信且证书链完整，管理员可登录。
- App 使用同一 HTTPS 地址连接并完成双向同步（WS），空闲后仍可使用；仅 curl 成功不能证明 WS 正常。
- 用两个外网客户端检查 HTTP 是否识别为不同 IP、限流是否隔离；若仍是代理 IP，回查转发头和信任范围。

## 5. 备份、损坏恢复与升级

**June 在 NAS 操作：** 备份应用目录下整个 `data/` 和安全保存的 `.env`。至少包含：

- `data/data/lux/accounts.json`：账号、邀请码等；
- `data/data/lux/sessions.json`：登录会话；
- `data/data/users/`：用户同步数据、设备、快照等，以及 `data/data/` 中其余服务数据。

一起听聊天永久保存在 `DATA_PATH/lux/together-chat/<roomId 的 UTF-8 十六进制编码>.jsonl`（默认宿主机 `data/data/lux/together-chat/`），关房或重启都不会清理，存储会随聊天量持续增长，请将此目录纳入备份并监控磁盘空间；关房后任何人都不能再通过 RPC 读取。需手动删除时先停止容器，按文件中 `roomId` 确认目标并备份，再删除对应 `.jsonl` 文件后启动；删除不可恢复。运行中备份可能包含未写完的末行，读取时会忽略该行。

可停止容器后复制，也可运行中复制：关键 JSON 以原子替换保存，单文件不会读到半份写入；运行中跨文件副本可能对应不同时刻，需一致快照时先停止容器。不要把 `.tmp-*` 当作有效备份。

已有 `accounts.json`／`sessions.json` 不可读、损坏或结构无效时，服务会**拒绝启动**，`restart: unless-stopped` 可能导致重启循环。查看日志中的 `*.corrupt-<timestamp>` 备份路径（备份失败也会记录原因），然后：

1. 停止容器，保留原文件和损坏副本供排查；损坏副本不是可直接恢复的正常备份。
2. 将已知完好的备份放回对应路径，确认 uid/gid 1000 可读写，再启动并检查日志。
3. 无完好备份时，移走损坏文件可重建空库，但移走账号库会失去账号／邀请关联，移走会话库会使已有会话失效；确认接受后再操作，不要直接删除数据目录。

升级前备份，在 Docker → Compose 中拉取新镜像并重新创建容器，或在应用目录执行 `docker compose pull`、`docker compose up -d`。可改为明确版本 tag 便于回退；保留绑定挂载及原 `LUX_TOKEN_SECRET`。入口先以 root 检查 `/server/data`，旧数据属主不符时自动 chown，再以非 root uid/gid **1000** 运行；首次迁移大目录可能较慢，不要覆盖 `user:` 跳过修复。升级后重新检查健康状态及 WS 同步，重启会清空一起听房间。

## 6. 通用 Nginx 反向代理

在已有可信 TLS 证书的 HTTPS server 中代理到 NAS；示例假设 Nginx 与源站在同一主机，其他部署需调整地址。`map` 放在 `http` 块中：

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
}
# 放入已配置 listen 443 ssl 和证书的 server 块：
location / {
    proxy_pass http://127.0.0.1:9527;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_read_timeout 300s;
    proxy_buffering off;
}
```

**June 在 NAS 操作：** 将 Nginx 的实际源地址加入 `LUX_TRUST_PROXY`，保留 `PROXY_HEADER=x-forwarded-for`，设置最终 HTTPS 地址并重复验证。`proxy_buffering off` 为后续 SSE／流式响应保留及时转发能力；若前面还有 PassNAT，也需验证该层缓冲行为。
