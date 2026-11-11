# MineBot dev — Linux VPS 纯挂机面板
FROM node:22-alpine

WORKDIR /app

# 先拷依赖清单利用层缓存, 再装生产依赖
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 拷贝应用代码 (public 整目录为前端多文件结构)
COPY index.js ./
COPY public ./public

# 非 root 运行
RUN addgroup -S app && adduser -S app -G app \
    && chown -R app:app /app
USER app

ENV PORT=4681 \
    NODE_ENV=production

EXPOSE 4681

# bots_config.json 挂卷持久化; 健康检查走登录页
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1:4681/ >/dev/null 2>&1 || exit 1

CMD ["node", "index.js"]
