# Lux Music Sync Server

Lux Music 数据同步服务端。本项目目前用于收藏列表数据同步，类似桌面版的数据同步服务，只不过它现在是一个独立版的服务，可以将其部署到服务器上使用。

本项目需要有一些服务器操作经验的人使用，若遇到问题欢迎反馈。

**由于服务本身不提供 HTTPS 协议支持，若将服务部署在公网，请务必使用 Nginx 之类的服务做反向代理（SSL 证书需可信且[证书链完整](https://stackoverflow.com/a/60020493)），实现客户端到服务器之间的 HTTPS 连接。**


## 环境要求

- Node.js 24+

## 使用方法

### 安装 Node.js

Cent OS 可以运行以下命令安装：

```bash
sudo yum install -y gcc-c++ make
curl -sL https://rpm.nodesource.com/setup_24.x | sudo -E bash  -
sudo yum install nodejs -y
```

基于 Debian、Ubuntu 发行版的系统使用以下命令安装：

```bash
sudo apt-get install -y build-essential
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
```

安装完毕后输入以下命令，正常情况下会显示 Node.js 的版本号。

```bash
node -v
```

### 安装 PM2（非必须）

PM2 是一个 Node.js 服务管理工具，可以在服务崩溃时自动重启，更多使用方式请自行百度。

```bash
npm i -g pm2
```

*注：若安装失败，则可能需要以管理员权限安装。*

若没有安装 PM2，则后面 `pm2` 开头的命令都可以跳过。

### 安装依赖

*若安装依赖过程中出现因 `utf-8-validate` 包编译失败的错误，请尝试搜索相关错误解决。若实在无法解决，则可以编辑 `package.json` 文件删除`dependencies` 下的 `utf-8-validate` 后，重新运行 `npm ci --omit=dev` 或 `npm ci` 即可。*

如果你是在 GitHub Releases 下载的压缩包，则解压后在项目目录执行以下命令安装依赖：

```bash
npm ci --omit=dev
```

如果你是直接克隆的源码，则在本目录中运行以下命令：

```bash
npm ci
npm run build
```

### 配置 `config.js`

按照文件中的说明配置好本目录下的 `config.js` 文件

### 配置 `ecosystem.config.js` 中的 `env_production`

可以在这里配置 PM2 的启动配置，具体根据你的需求配置

### 启动服务器

```bash
npm run prd
```

若你没有安装 PM2，则可以用 `npm start` 启动。

### 查看启动日志

```bash
pm2 logs
```

若无报错相关的日志，则说明服务启动成功。

### 设置服务开机启动

***注意：该命令对 Windows 系统无效，Windows 需用批处理的方式设置。***

```bash
pm2 save
pm2 startup
```

到这里服务已搭建完成，但是为了你的数据安全，我们**强烈建议**使用 Nginx 之类的服务为同步服务添加 TLS 保护！

### 配置 Nginx

<!-- 看官网安装文档完成：<https://www.nginx.com/resources/wiki/start/topics/tutorials/install/> -->

#### 说明

代理需要配置两条规则：

1. 代理链接 URL 根路径下所有子路径的 **WebSocket** 请求到 Lux Music Sync 服务；
2. 代理链接 URL 根路径下所有子路径的 **HTTP** 请求到 Lux Music Sync 服务。

#### 配置

编辑 Nginx 配置文件，在 `server` 下添加代理规则，如果你当前 `server` 块下只打算配置 Lux Music Sync 服务，那么可以使用以下配置：

```conf
map $http_upgrade $connection_upgrade{
    default upgrade;
    '' close;
}
server {
    # ...
    location / {
        proxy_set_header X-Real-IP $remote_addr;  # 该头部与config.js文件的 proxy.header 对应
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Host  $http_host;
        proxy_pass http://127.0.0.1:9527;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
    }
}
```

如果你当前 `server` 块下存在其他服务，那么可以配置路径前缀转发：

```conf
map $http_upgrade $connection_upgrade{
    default upgrade;
    '' close;
}
server {
    # ...
    location /xxx/ {
        proxy_set_header X-Real-IP $remote_addr;  # 该头部与config.js文件的 proxy.header 对应
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Host  $http_host;
        proxy_pass http://127.0.0.1:9527;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
    }
}
```

*注：上面的 `xxx` 是你想要代理的路径前缀（可以多级）。*

注意 `$remote_addr` 的转发名字与 `config.js` 中的 `proxy.header` 对应，并同时启用 `proxy.enabled`（或与环境变量的 `PROXY_HEADER` 对应），这用于校验相同 IP 多次使用错误连接码连接时的封禁。

## 升级新版本

若更新日志无特别说明，注意保留**你修改过**的 `config.js`、`ecosystem.config.js` 或 `Dockerfile` 之类的配置文件，以及 `data`、`logs` 目录即可，其他的都可以删除后再将新版本的文件复制进去，以下是更新日志无特别说明的更新流程：

使用在 GitHub Releases 下载的压缩包运行的服务：

1. 删除项目目录下的 `server`、`node_modules` 目录以及 `index.js`、`package.json`、`package-lock.json` 文件；
2. 将新版本的 `server` 目录以及 `index.js`、`package.json`、`package-lock.json` 文件复制进去；
3. 执行 `npm ci --omit=dev`；
4. 重启服务，执行 `pm2 restart <服务名称/ID>` 重启服务（可以先执行 `pm2 list` 查看服务 ID 或名称）。

使用源码编译运行的服务：

1. 重新下载源码或使用 Git 将代码更新到最新版本；
2. 执行 `npm ci` 与 `npm run build`；
3. 重启你的服务。

使用 Docker 时，可以把代码更新到最新后重新构建镜像，也可以直接拉取 GHCR 上的稳定版或开发版镜像，见下方 Docker 一节。

## 从快照文件恢复数据

方式一：

使用快照文件转换工具将其转换成列表备份文件后再导入备份：https://lyswhut.github.io/lx-music-sync-snapshot-transform/

方式二：

1. 停止同步服务；
2. 修改 `data/users/<用户名>/list/snapshotInfo.json` 里面的 `latest` 为你那个备份文件的 key 名（即 `snapshot` 文件夹下去掉 `snapshot_` 前缀后的名字）；
3. 删除 `snapshotInfo.json` 文件内 `clients` 内的所有设备信息，删除后的内容类似于：`{...其他内容,"clients":{}}`；
4. 启用同步服务，连接后勾选「完全覆盖」，选择「远程覆盖本地」。

## 附录

### 可用的环境变量

| 变量名称 | 说明 |
| --- | --- |
| `PORT` | 绑定的端口号，默认为 `9527`。 |
| `BIND_IP` | 绑定的 IP 地址，默认为 `127.0.0.1`，使用 `0.0.0.0` 将接受所有 IPv4 请求，使用 `::` 将接受所有 IP 请求。 |
| `PROXY_HEADER` | 代理转发的请求头 原始 IP，如果设置，则自动启用。 |
| `CONFIG_PATH` | 配置文件路径，默认使用项目目录下的 `config.js`。 |
| `LOG_PATH` | 服务日志保存路径，默认保存在服务目录下的 `logs` 文件夹内。 |
| `DATA_PATH` | 同步数据保存路径，默认保存在服务目录下的 `data` 文件夹内。 |
| `MAX_SNAPSHOT_NUM` | 公共最大备份快照数。 |
| `LIST_ADD_MUSIC_LOCATION_TYPE` | 公共添加歌曲到我的列表时的方式，可用值为 `top` 和 `bottom`。 |
| `LUX_TOKEN_SECRET` | **生产环境必须设置**的 Web 登录 JWT 签名密钥。未设置时服务仍可启动，但会向控制台打印明显警告，并在 `data/lux/accounts.json` 写入随机 secret；容器重建或误删该文件会导致全部 Web 登录态失效。 |
| `LUX_BOOTSTRAP_TOKEN` | 首次创建管理员的保护 token。未配置时，`POST /api/auth/bootstrap` **仅允许**来自本机回环地址（`127.0.0.1` / `::1`）的请求；公网 / Docker 端口映射访问会被拒绝。配置后，远程请求需在请求头携带 `x-lux-bootstrap-token: <token>`。也可用 `LUX_ADMIN_USER` + `LUX_ADMIN_PASSWORD` 在启动时直接创建管理员，避免走 bootstrap。 |
| `LUX_ADMIN_USER` / `LUX_ADMIN_PASSWORD` | 可选。若同时设置且该用户尚不存在，启动时自动创建管理员账号（适合 Docker 首次部署）。 |
| `LUX_LOG_SYNC_CODES` | 设为 `1` 或 `true` 时，启动日志明文打印同步连接码；默认脱敏。`DEBUG` 非空时同样打印明文。 |
| `LX_USER_` | 以 `LX_USER_` 开头的环境变量将被识别为用户配置，可用的配置语法为：<br />1. `LX_USER_user1='xxx'`；<br />2. `LX_USER_user1='{"password":"xxx"}'`。<br />其中 `LX_USER_` 会被去掉，剩下的 `user1` 为用户名，`xxx` 为用户密码（**连接码**）。<br />配置方式 1 为简写模式，只指定用户名及密码（链接码），其他配置使用公共配置。<br />配置方式 2 为 JSON 字符串格式，配置内容参考 `config.js`，由于该方式在变量名指定了用户名，所以 JSON 里的用户名是可选的。 |

关于 `config.users`（连接码）与 `accounts.json`（托管账号）的关系，见 [docs/user-models.md](docs/user-models.md)。

### PM2 常用命令

- 查看服务列表：`pm2 list`。
- 服务控制台的输出日志：`pm2 logs`。
- 重启服务：`pm2 restart <服务名称/ID>`。
- 停止服务：`pm2 stop <服务名称/ID>`。

### Docker

本项目提供 Dockerfile 与 `docker-compose.yml`，可直接构建镜像并部署到服务器。

#### 构建镜像

在 `lux-music-server` 目录执行：

```bash
docker build -t lux-music-server:local .
```

#### 从 GHCR 拉取镜像

镜像只发布到 GitHub Container Registry（`ghcr.io`），不再推送 Docker Hub。Actions 使用仓库自带的 `GITHUB_TOKEN` 推送，不需要额外的 registry secret。

稳定版（合并进 `master` 并完成发布之后）：

```bash
docker pull ghcr.io/junedrinleng/lux-music-server:latest
docker pull ghcr.io/junedrinleng/lux-music-server:0.1.0
docker pull ghcr.io/junedrinleng/lux-music-server:0.1
```

开发版（合并进 `dev` 并完成发布之后）：

```bash
docker pull ghcr.io/junedrinleng/lux-music-server:dev
docker pull ghcr.io/junedrinleng/lux-music-server:0.1.0-dev.1
```

- `:latest` 和 `:X.Y` 只跟随稳定版。同一个 minor 打出 hotfix 后，`:X.Y` 会改指向新的 patch；`:X.Y.Z` 不变。
- `:dev` 跟随最新开发版。`:X.Y.Z` 和 `:X.Y.Z-dev.N` 发布后不再覆盖。
- 首次推送后，包的默认可见性可能是 Private。需要别人能拉取时，到该 Package 的设置里改成 Public。

若使用 GHCR 镜像启动，请把下面示例中的 `lux-music-server:local` 替换为 `ghcr.io/junedrinleng/lux-music-server:latest`（试开发版则用 `:dev`）。

#### 使用 docker run 启动

```bash
docker run -d \
  --name lux-music-server \
  --restart unless-stopped \
  -p 9527:9527 \
  -v lux-music-server-data:/server/data \
  -e PORT=9527 \
  -e BIND_IP=0.0.0.0 \
  -e DATA_PATH=/server/data/data \
  -e LOG_PATH=/server/data/logs \
  -e LUX_TOKEN_SECRET=请替换为随机长字符串 \
  lux-music-server:local
```

说明：

- `/server/data` 是容器内持久化数据卷，包含同步数据、Web 账号数据和日志。
- **必须**设置固定的 `LUX_TOKEN_SECRET`，否则容器重建后已登录的 Web 会话会失效（未设置时启动会警告，但不会拒绝启动）。
- 首次管理员建议任选其一：
  1. 设置 `LUX_ADMIN_USER` + `LUX_ADMIN_PASSWORD`，由进程启动时自动创建；
  2. 设置 `LUX_BOOTSTRAP_TOKEN`，再用带 `x-lux-bootstrap-token` 的请求或管理台（需自行带上该头）完成 bootstrap；
  3. 在容器内对本机 `127.0.0.1` 调用 `POST /api/auth/bootstrap`（未配置 bootstrap token 时，映射到宿主机的端口**不能**算本机回环）。
- 未建管理员前，勿将服务端口直接暴露到公网。

#### 使用 docker compose 启动

```bash
docker compose up -d --build
```

默认会：

- 映射宿主机 `9527` 到容器 `9527`。
- 挂载命名卷 `lux-music-server-data` 到 `/server/data`。
- 监听 `0.0.0.0`，方便局域网或反向代理访问。

#### 验证部署

启动后可访问：

```text
http://<服务器 IP>:9527/api/health
http://<服务器 IP>:9527/hello
http://<服务器 IP>:9527/id
http://<服务器 IP>:9527/admin
```

其中 `/hello`、`/id` 是同步协议兼容端点，`/admin` 是 Web 管理后台。

#### 反向代理与 HTTPS

公网部署时建议使用 Nginx/Caddy 等反向代理提供 HTTPS/WSS，并正确转发 WebSocket upgrade 请求。如果启用了真实 IP 转发，请同步设置 `PROXY_HEADER`，例如：

```bash
-e PROXY_HEADER=x-real-ip
```

服务名称 `serverName` 当前请通过 `config.js` 配置；`SERVER_NAME` 环境变量目前不是有效配置项。

#### 自动发布

合并进 `dev` 或 `master` 时由 GitHub Actions 发布（不再由「推送 `v*.*.*` tag」触发）：

- `dev`：预发布 `vX.Y.Z-dev.N`（N 自动递增），镜像 `:dev` 和 `:X.Y.Z-dev.N`。
- `master`：正式 Release。版本号就是当时的 `package.json`（`X.Y.Z`）。镜像 `:latest`、`:X.Y.Z`、`:X.Y`。hotfix 只把 patch 加一。
- `package.json` 里始终是最近一次稳定版。开发版号只在构建时注入，不会写回仓库。
- 对应的 git tag 已经存在就跳过，不会覆盖已有 Release，也不会覆盖已经推送的版本镜像。
- 只改文档（`**.md`、`docs/**`）不会触发发布。

默认构建 `linux/amd64` 镜像。若后续需要 ARM 服务器镜像，可在 workflow 中重新启用 `linux/arm64` 平台。

也可以看此 Issue 提供的历史 Docker 解决方案：<https://github.com/lyswhut/lx-music-sync-server/issues/4>
