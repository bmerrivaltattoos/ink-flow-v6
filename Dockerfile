FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node package.json server.js ./
COPY --chown=node:node lib ./lib
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787
USER node
EXPOSE 8787
CMD ["node", "server.js"]
