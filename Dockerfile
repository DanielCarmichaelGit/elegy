FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY bin ./bin
COPY src ./src
ENV ELEGY_DATA=/data
VOLUME /data
EXPOSE 4321
CMD ["node", "bin/elegy.js", "serve", "--port", "4321"]
