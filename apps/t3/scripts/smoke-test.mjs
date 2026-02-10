import { spawn } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address !== "object") {
        reject(new Error("Could not resolve free port."));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.on("error", (error) => reject(error));
  });
}

function waitForProcessExit(processRef) {
  return new Promise((resolve) => {
    processRef.once("exit", (code) => resolve(code));
  });
}

async function terminateProcess(processRef, timeoutMs = 5_000) {
  if (processRef.exitCode !== null || processRef.signalCode !== null) {
    return;
  }

  processRef.kill("SIGTERM");
  const exited = await Promise.race([
    waitForProcessExit(processRef).then(() => true),
    new Promise((resolve) => {
      setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);

  if (exited) {
    return;
  }

  processRef.kill("SIGKILL");
  await waitForProcessExit(processRef);
}

function waitForSocketCloseCode(socket, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Smoke test failed: websocket close event timed out."));
    }, timeoutMs);
    socket.addEventListener("close", (event) => {
      clearTimeout(timer);
      resolve(event.code);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Smoke test failed: websocket client error before close."));
    });
  });
}

function waitForStartupUrl(readOutput, processRef, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const finish = (callback, value) => {
      clearInterval(timer);
      processRef.off("exit", onExit);
      callback(value);
    };
    const onExit = (code) => {
      finish(
        reject,
        new Error(
          `Smoke test failed: CLI exited before startup URL was printed (exit code ${String(code)}).`,
        ),
      );
    };
    processRef.once("exit", onExit);

    const startedAt = Date.now();
    const timer = setInterval(() => {
      const output = readOutput();
      const match = output.match(/CodeThing is running at (http:\/\/[^\s]+)/);
      if (match?.[1]) {
        finish(resolve, match[1]);
        return;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        finish(reject, new Error("Smoke test failed: did not observe startup URL in CLI output."));
      }
    }, 100);
  });
}

async function main() {
  const [backendPort, webPort] = await Promise.all([getFreePort(), getFreePort()]);
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const appRoot = path.resolve(scriptDir, "..");
  const distCli = path.join(appRoot, "dist", "cli.js");
  if (!fs.existsSync(distCli)) {
    throw new Error("Missing dist/cli.js. Run `bun run --cwd apps/t3 build` first.");
  }

  const child = spawn(
    process.execPath,
    [
      distCli,
      "--no-open",
      "--backend-port",
      String(backendPort),
      "--web-port",
      String(webPort),
    ],
    {
      cwd: appRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });

  try {
    const appUrl = await waitForStartupUrl(() => output, child);
    const parsedAppUrl = new URL(appUrl);

    const page = await fetch(parsedAppUrl);
    if (page.status !== 200) {
      throw new Error(`Smoke test failed: expected web status 200, received ${page.status}.`);
    }

    const wsUrl = parsedAppUrl.searchParams.get("ws");
    if (!wsUrl) {
      throw new Error("Smoke test failed: launch URL did not include ws runtime parameter.");
    }
    const parsedWsUrl = new URL(wsUrl);
    if (parsedWsUrl.port !== String(backendPort)) {
      throw new Error(
        `Smoke test failed: expected backend port ${backendPort}, got ${parsedWsUrl.port}.`,
      );
    }
    if (!parsedWsUrl.searchParams.get("token")) {
      throw new Error("Smoke test failed: websocket URL is missing runtime auth token.");
    }

    const unauthorizedWsUrl = `${parsedWsUrl.origin}${parsedWsUrl.pathname}`;
    const unauthorizedWs = new WebSocket(unauthorizedWsUrl);
    const unauthorizedCode = await waitForSocketCloseCode(unauthorizedWs);
    if (unauthorizedCode !== 4001) {
      throw new Error(
        `Smoke test failed: expected unauthorized close code 4001, received ${unauthorizedCode}.`,
      );
    }

    const wrongTokenWs = new WebSocket(
      `${parsedWsUrl.origin}${parsedWsUrl.pathname}?token=wrong-token`,
    );
    const wrongTokenCode = await waitForSocketCloseCode(wrongTokenWs);
    if (wrongTokenCode !== 4001) {
      throw new Error(
        `Smoke test failed: expected wrong-token close code 4001, received ${wrongTokenCode}.`,
      );
    }

    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Smoke test failed: websocket did not respond in time.")),
        20_000,
      );
      ws.addEventListener("open", () => {
        ws.send(
          JSON.stringify({
            type: "request",
            id: "smoke",
            method: "app.health",
          }),
        );
      });
      ws.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data));
        if (message.type !== "response" || message.id !== "smoke" || message.ok !== true) {
          return;
        }
        if (message.result?.status !== "ok") {
          return;
        }
        if (message.result?.launchCwd !== appRoot) {
          clearTimeout(timer);
          reject(
            new Error(
              `Smoke test failed: expected launch cwd ${appRoot}, got ${String(
                message.result?.launchCwd,
              )}.`,
            ),
          );
          return;
        }
        if (message.result?.activeClientConnected !== true) {
          clearTimeout(timer);
          reject(
            new Error(
              "Smoke test failed: app.health did not report active websocket client connectivity.",
            ),
          );
          return;
        }
        if (!Number.isInteger(message.result?.sessionCount) || message.result.sessionCount < 0) {
          clearTimeout(timer);
          reject(
            new Error(
              `Smoke test failed: expected non-negative integer sessionCount, got ${String(
                message.result?.sessionCount,
              )}.`,
            ),
          );
          return;
        }

        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("Smoke test failed: websocket client error."));
      });
    });
    ws.close();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Smoke test failed."}\n`);
    process.stderr.write(output);
    process.exitCode = 1;
  } finally {
    await terminateProcess(child);
  }
}

await main();
