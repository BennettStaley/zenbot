FROM node:latest

RUN mkdir -p /app
WORKDIR /app

COPY package.json /app/
RUN yarn global add node-gyp && yarn install

COPY . /app
RUN ln -s /app/zenbot.sh /usr/local/bin/zenbot

ENV NODE_ENV production

ENTRYPOINT ["/usr/local/bin/node", "zenbot.js"]
CMD [ "trade", "--paper" ]
