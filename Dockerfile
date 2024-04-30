FROM node:20.12.2-bookworm-slim
WORKDIR /app
COPY . .
RUN npm ci --production
RUN chown -R node:node .
USER node
ENTRYPOINT ["npm", "start", "--"]
