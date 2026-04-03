FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p /app/downloads
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
