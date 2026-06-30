FROM node:20-alpine AS builder

WORKDIR /source-code
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build \
  && rm -rf node_modules \
  && npm ci --omit=dev

FROM node:20-alpine AS final

WORKDIR /server

ENV NODE_ENV=production
ENV PORT=9527
ENV BIND_IP=0.0.0.0
ENV DATA_PATH=/server/data/data
ENV LOG_PATH=/server/data/logs

# 可选：生产环境建议设置固定 token secret，避免容器重建后登录态全部失效。
# ENV LUX_TOKEN_SECRET='change-me'
# 可选：已有管理员后，如需通过 API 执行 bootstrap 维护操作，可设置该 token。
# ENV LUX_BOOTSTRAP_TOKEN='change-me'
# 可选：反向代理真实 IP 请求头。
# ENV PROXY_HEADER='x-real-ip'
# 可选：兼容 LX 连接码用户。
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
