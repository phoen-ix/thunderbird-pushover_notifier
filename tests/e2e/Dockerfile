# Image for the end-to-end test: Node.js, git, openssl, an official Thunderbird
# build with the libraries it needs to run headless, and the GreenMail test
# mail server (for the IMAP scenarios).
FROM node:26.11.1-trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git openssl xz-utils openjdk-21-jre-headless \
      libasound2t64 libdbus-glib-1-2 libgtk-3-0t64 libpci3 libx11-xcb1 libxtst6 \
 && rm -rf /var/lib/apt/lists/*

ARG GREENMAIL_VERSION=2.1.14
RUN curl -fsSL -o /opt/greenmail.jar \
    "https://repo1.maven.org/maven2/com/icegreen/greenmail-standalone/${GREENMAIL_VERSION}/greenmail-standalone-${GREENMAIL_VERSION}.jar"

ARG TB_VERSION
ARG TB_LANG=en-US
RUN curl -fsSL "https://download-installer.cdn.mozilla.net/pub/thunderbird/releases/${TB_VERSION}/linux-x86_64/${TB_LANG}/thunderbird-${TB_VERSION}.tar.xz" \
    | tar -xJ -C /opt

ENV TB_BINARY=/opt/thunderbird/thunderbird
ENV GREENMAIL_JAR=/opt/greenmail.jar
WORKDIR /repo
