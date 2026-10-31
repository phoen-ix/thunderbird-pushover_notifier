// Local stand-ins for the outside world of the end-to-end test:
//   - a minimal POP3 server that delivers test mail to Thunderbird,
//   - GreenMail as IMAP server (with SMTP to put mail into it),
//   - a mock of api.pushover.net, reached through an HTTPS proxy that presents
//     a certificate from a throwaway test CA.

import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";

/** Builds an RFC 5322 message with CRLF line endings. */
export function buildMail({ id, from, subject, text, html, date }) {
  const lines = [
    `From: ${from}`,
    "To: Tester <tester@example.com>",
    `Subject: ${subject}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${id}@e2e.test>`,
    "MIME-Version: 1.0",
    `Content-Type: ${html ? "text/html" : "text/plain"}; charset=UTF-8`,
    "Content-Transfer-Encoding: 8bit",
    "",
    ...(html ?? text ?? "").split("\n"),
  ];
  return lines.join("\r\n");
}

/** POP3 (RFC 1939) server serving whatever `setMessages()` was given last. */
export async function startPop3Server() {
  let mailbox = [];
  const log = [];

  const server = net.createServer(socket => {
    let buffer = "";
    let deleted = new Set();
    const send = line => socket.write(`${line}\r\n`);
    const visible = () => mailbox.map((message, i) => ({ ...message, number: i + 1 })).filter(m => !deleted.has(m.number));
    const size = message => Buffer.byteLength(message.raw);

    send("+OK e2e POP3 server ready");
    socket.on("data", chunk => {
      buffer += chunk.toString("utf8");
      let index;
      while ((index = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const [command, ...args] = line.split(" ");
        log.push(command.toUpperCase() === "PASS" ? "PASS ***" : line);
        const message = visible().find(m => m.number === Number(args[0]));
        switch (command.toUpperCase()) {
          case "CAPA":
            send("+OK\r\nUSER\r\nUIDL\r\nTOP\r\n.");
            break;
          case "USER":
          case "PASS":
          case "NOOP":
            send("+OK");
            break;
          case "RSET":
            deleted = new Set();
            send("+OK");
            break;
          case "STAT":
            send(`+OK ${visible().length} ${visible().reduce((sum, m) => sum + size(m), 0)}`);
            break;
          case "LIST":
          case "UIDL": {
            const describe = m => `${m.number} ${command.toUpperCase() === "LIST" ? size(m) : m.uid}`;
            if (args[0]) {
              send(message ? `+OK ${describe(message)}` : "-ERR no such message");
            } else {
              send(`+OK\r\n${visible().map(describe).map(l => `${l}\r\n`).join("")}.`);
            }
            break;
          }
          case "RETR":
          case "TOP":
            if (!message) {
              send("-ERR no such message");
              break;
            }
            // Dot-stuffing: lines starting with "." get another ".".
            send(`+OK ${size(message)} octets\r\n${message.raw.replace(/^\./gm, "..")}\r\n.`);
            break;
          case "DELE":
            if (message) {
              deleted.add(message.number);
            }
            send(message ? "+OK" : "-ERR no such message");
            break;
          case "QUIT":
            mailbox = mailbox.filter((_, i) => !deleted.has(i + 1));
            send("+OK bye");
            socket.end();
            break;
          default:
            send("-ERR not supported");
        }
      }
    });
    socket.on("error", () => {});
  });

  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    log,
    /** Replaces the mailbox; each mail is { id, raw }. */
    setMessages(messages) {
      mailbox = messages.map(message => ({ uid: message.id, raw: message.raw }));
    },
    get pending() {
      return mailbox.length;
    },
    close: () => server.close(),
  };
}

/**
 * GreenMail (https://greenmail-mail-test.github.io/greenmail/) with IMAP and
 * SMTP, for mailbox tester/secret. `deliver()` sends a mail to its Inbox.
 */
export async function startImapServer(jar) {
  const imapPort = await freePort();
  const smtpPort = await freePort();
  const output = [];
  const child = spawn(
    "java",
    [
      "-Dgreenmail.hostname=127.0.0.1",
      `-Dgreenmail.imap.port=${imapPort}`,
      `-Dgreenmail.smtp.port=${smtpPort}`,
      "-Dgreenmail.users=tester:secret@example.com",
      "-jar",
      jar,
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", chunk => output.push(chunk.toString()));
  }
  await waitForPort(imapPort, () => output.join(""));
  await waitForPort(smtpPort, () => output.join(""));
  return {
    imapPort,
    output,
    deliver: raw => smtpSend(smtpPort, "sender@example.com", "tester@example.com", raw),
    close: () => child.kill(),
  };
}

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForPort(port, describe, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise(resolve => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => socket.end(() => resolve(true)));
      socket.once("error", () => resolve(false));
    });
    if (open) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Port ${port} did not open:\n${describe()}`);
}

/** Minimal SMTP client (RFC 5321) for delivering one message. */
async function smtpSend(port, from, to, raw) {
  const socket = net.connect(port, "127.0.0.1");
  let buffer = "";
  let waiting = null;
  socket.on("data", chunk => {
    buffer += chunk.toString();
    // A reply is complete with a line "<code> <text>" (no dash after the code).
    const match = buffer.match(/(?:^|\r\n)(\d{3}) [^\r\n]*\r\n$/);
    if (match && waiting) {
      const done = waiting;
      waiting = null;
      buffer = "";
      done(match[1]);
    }
  });
  const reply = () => new Promise(resolve => (waiting = resolve));
  const command = async (line, expected) => {
    const pending = reply();
    socket.write(`${line}\r\n`);
    const code = await pending;
    if (code !== expected) {
      throw new Error(`SMTP "${line.split(" ")[0]}" answered ${code}`);
    }
  };

  const greeting = await reply();
  if (greeting !== "220") {
    throw new Error(`SMTP greeting ${greeting}`);
  }
  await command("EHLO e2e.test", "250");
  await command(`MAIL FROM:<${from}>`, "250");
  await command(`RCPT TO:<${to}>`, "250");
  await command("DATA", "354");
  await command(`${raw.replace(/^\./gm, "..")}\r\n.`, "250");
  await command("QUIT", "221");
  socket.end();
}

/** Creates a test CA and a certificate for api.pushover.net signed by it. */
export function createCertificates(dir) {
  const file = name => path.join(dir, name);
  const openssl = (...args) => execFileSync("openssl", args, { stdio: "pipe" });
  openssl(
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
    "-keyout", file("ca.key"), "-out", file("ca.pem"), "-subj", "/CN=Pushover Notifier E2E Test CA",
    "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"
  );
  openssl(
    "req", "-newkey", "rsa:2048", "-nodes",
    "-keyout", file("leaf.key"), "-out", file("leaf.csr"), "-subj", "/CN=api.pushover.net"
  );
  writeFileSync(file("leaf.ext"), "subjectAltName=DNS:api.pushover.net\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n");
  openssl(
    "x509", "-req", "-days", "2", "-in", file("leaf.csr"), "-CA", file("ca.pem"), "-CAkey", file("ca.key"),
    "-CAcreateserial", "-out", file("leaf.pem"), "-extfile", file("leaf.ext")
  );
  const caPem = readFileSync(file("ca.pem"), "utf8");
  return {
    caBase64: caPem.replace(/-----[^-]+-----|\s/g, ""),
    key: readFileSync(file("leaf.key")),
    cert: readFileSync(file("leaf.pem")),
  };
}

/**
 * HTTPS proxy that answers CONNECTs to api.pushover.net with a mock of the
 * Pushover API and refuses everything else. The mock mirrors the real API's
 * CORS behaviour: only messages.json allows cross-origin requests.
 */
export async function startPushoverMock({ key, cert }) {
  const requests = [];
  const calls = [];
  let mode = "ok";
  const refused = [];

  const api = http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => (body += chunk));
    req.on("end", () => {
      const url = new URL(req.url, "https://api.pushover.net");
      const reply = (status, data, cors) => {
        res.writeHead(status, {
          "content-type": "application/json",
          ...(cors ? { "access-control-allow-origin": "*" } : {}),
        });
        res.end(JSON.stringify(data));
      };
      calls.push(`${req.method} ${url.pathname}`);
      const message = url.pathname === "/1/messages.json";
      if (message && req.method === "POST") {
        requests.push({ ...Object.fromEntries(new URLSearchParams(body)), receivedAt: Date.now() });
      }
      if (mode === "reject" && req.method !== "OPTIONS") {
        reply(400, { token: "invalid", errors: ["application token is invalid"], status: 0, request: "e2e" }, message);
      } else if (mode === "error-once" && message && req.method === "POST") {
        mode = "ok";
        reply(500, { status: 0, errors: ["internal error"] }, true);
      } else if (url.pathname === "/1/users/validate.json" && req.method === "POST") {
        reply(200, { status: 1, devices: ["pixel", "iphone"], licenses: ["Android", "iOS"] }, false);
      } else if (url.pathname === "/1/sounds.json" && req.method === "GET") {
        reply(200, { status: 1, sounds: { pushover: "Pushover (default)", "e2e-custom": "My E2E Sound" } }, false);
      } else if (message && req.method === "POST") {
        reply(200, { status: 1, request: `e2e-${requests.length}` }, true);
      } else if (url.pathname === "/1/messages.json" && req.method === "OPTIONS") {
        res.writeHead(200, { "access-control-allow-origin": "*", "access-control-allow-methods": "POST" });
        res.end();
      } else {
        reply(404, { status: 0, errors: ["not found"] }, false);
      }
    });
  });

  const proxy = http.createServer((req, res) => {
    refused.push(req.url);
    res.writeHead(403);
    res.end();
  });
  proxy.on("connect", (req, socket) => {
    if (req.url !== "api.pushover.net:443") {
      refused.push(req.url);
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    const secure = new tls.TLSSocket(socket, { isServer: true, key, cert });
    secure.on("error", () => {});
    api.emit("connection", secure);
  });

  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
  return {
    port: proxy.address().port,
    requests,
    /** Every API call as "METHOD /path". */
    calls,
    refused,
    clear() {
      requests.length = 0;
      calls.length = 0;
    },
    /**
     * "ok" accepts everything, "reject" answers every call like Pushover does
     * for a bad token, "error-once" answers the next message with HTTP 500.
     */
    setMode(newMode) {
      mode = newMode;
    },
    close: () => proxy.close(),
  };
}
