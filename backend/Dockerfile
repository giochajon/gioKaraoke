FROM node:20-alpine
WORKDIR /app
COPY backend/package*.json ./
RUN npm install --production
COPY backend/server.js .
COPY frontend/ /frontend/
RUN chown -R node:node /app /frontend
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q -O - http://localhost:3000/ || exit 1
CMD ["node", "server.js"]
