FROM node:22-alpine
WORKDIR /app
COPY package.json server.js index.html ./
ENV DB_PATH=/data/game.db
CMD ["node", "server.js"]
