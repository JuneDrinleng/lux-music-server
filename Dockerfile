FROM node:24-alpine AS builder

WORKDIR /source-code
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build \
  && rm -rf node_modules \
  && npm ci --omit=dev

FROM node:24-alpine AS final

WORKDIR /server

ENV NODE_ENV=production
ENV PORT=9527
ENV BIND_IP=0.0.0.0
ENV DATA_PATH=/server/data/data
ENV LOG_PATH=/server/data/logs

# 生产环境务必设置固定 token secret，避免容器重建后登录态全部失效（未设置会打警告）。
# ENV LUX_TOKEN_SECRET='change-me'
# 首次远程 bootstrap 需要此 token；未设置时仅容器内 127.0.0.1/::1 可调用 POST /api/auth/bootstrap。
# ENV LUX_BOOTSTRAP_TOKEN='change-me'
# 可选：启动时自动创建管理员（推荐 Docker 首次部署）。
# ENV LUX_ADMIN_USER='admin'
# ENV LUX_ADMIN_PASSWORD='change-me'
# 可选：启动日志明文打印同步连接码（默认脱敏）。
# ENV LUX_LOG_SYNC_CODES=0
# 可选：反向代理真实 IP 请求头。
# ENV PROXY_HEADER='x-real-ip'
# 可选：配置兼容旧客户端协议的连接码用户。
# ENV LX_USER_user1='123.123'
# ENV LX_USER_user2='{ "password": "123.456", "maxSnapshotNum": 10, "list.addMusicLocationType": "top" }'
# 可选：自定义配置文件路径。
# ENV CONFIG_PATH='/server/config.js'

COPY --from=builder /source-code/server ./server
COPY --from=builder /source-code/node_modules ./node_modules
COPY --from=builder /source-code/config.js ./config.js
COPY --from=builder /source-code/index.js ./index.js
COPY --from=builder /source-code/package.json ./package.json

VOLUME /server/data
EXPOSE 9527

CMD ["node", "index.js"]
