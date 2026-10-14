FROM node:22-alpine
RUN apk add --no-cache postgresql-client
WORKDIR /app
COPY server.cjs ./server.cjs
COPY checkout.html ./checkout.html
USER node
CMD ["node", "server.cjs"]
