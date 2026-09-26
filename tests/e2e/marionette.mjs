// Minimal Marionette client (https://firefox-source-docs.mozilla.org/testing/marionette/Protocol.html).
// Messages are framed as `<byte length>:<JSON>`; commands are [0, id, name, params],
// responses [1, id, error, result].

import net from "node:net";

export class Marionette {
  #socket;
  #buffer = Buffer.alloc(0);
  #nextId = 1;
  #pending = new Map();
  #hello;

  static async connect(port, { timeoutMs = 90000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const client = new Marionette();
        await client.#open(port);
        return client;
      } catch (error) {
        if (Date.now() > deadline) {
          throw new Error(`Could not connect to Marionette on port ${port}: ${error.message}`);
        }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  }

  #open(port) {
    return new Promise((resolve, reject) => {
      this.#hello = { resolve, reject };
      this.#socket = net.connect(port, "127.0.0.1");
      this.#socket.on("data", chunk => this.#onData(chunk));
      this.#socket.on("error", reject);
      this.#socket.on("close", () => {
        for (const { reject: fail } of this.#pending.values()) {
          fail(new Error("Marionette connection closed"));
        }
        this.#pending.clear();
      });
    });
  }

  #onData(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      const colon = this.#buffer.indexOf(":");
      if (colon < 0) {
        return;
      }
      const length = Number(this.#buffer.subarray(0, colon).toString());
      if (this.#buffer.length < colon + 1 + length) {
        return;
      }
      const message = JSON.parse(this.#buffer.subarray(colon + 1, colon + 1 + length).toString());
      this.#buffer = this.#buffer.subarray(colon + 1 + length);
      if (this.#hello) {
        this.#hello.resolve(message);
        this.#hello = null;
        continue;
      }
      const [, id, error, result] = message;
      const pending = this.#pending.get(id);
      this.#pending.delete(id);
      if (!pending) {
        continue;
      }
      if (error) {
        pending.reject(new Error(`${error.error}: ${error.message}\n${error.stacktrace ?? ""}`));
      } else {
        pending.resolve(result);
      }
    }
  }

  send(name, params = {}) {
    const id = this.#nextId++;
    const json = JSON.stringify([0, id, name, params]);
    this.#socket.write(`${Buffer.byteLength(json)}:${json}`);
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }

  /** Runs `script` (an async function body; `arguments` holds `args`) in the chrome context. */
  async chrome(script, ...args) {
    const wrapped = `return (async () => {\n${script}\n})();`;
    const result = await this.send("WebDriver:ExecuteScript", { script: wrapped, args });
    return result?.value;
  }

  async startSession() {
    await this.send("WebDriver:NewSession", {});
    await this.send("WebDriver:SetTimeouts", { script: 120000 });
    // Marionette's content commands only know Firefox tabs, so everything,
    // including access to pages in Thunderbird tabs, goes through chrome.
    await this.send("Marionette:SetContext", { value: "chrome" });
  }

  close() {
    this.#socket.destroy();
  }
}
