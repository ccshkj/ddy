# 极简「仅内存转发」中继的部署镜像
# 用法：
#   docker build -t privacy-relay ./relay
#   docker run -d -p 3000:3000 --name privacy-relay privacy-relay
# 真机使用需在本容器前加一层 TLS（nginx/caddy/Cloudflare），对外暴露 wss://
FROM node:18-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY server.js ./
EXPOSE 3000
CMD ["node", "server.js"]
