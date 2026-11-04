// No command starts until the parent has durably recorded this process group.
// IPC disconnect also fires when the parent is SIGKILLed (no shutdown hook).
import { spawn } from "node:child_process";
let stopping = false;
let started = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  try {
    process.kill(-process.pid, "SIGTERM");
  } catch {}
  setTimeout(() => {
    try {
      process.kill(-process.pid, "SIGKILL");
    } catch {}
  }, 200);
};
process.on("disconnect", stop);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("message", (message) => {
  if (message?.kind !== "run" || started || stopping) return;
  started = true;
  const child = spawn("/bin/sh", ["-c", message.command], { stdio: "inherit" });
  child.on("error", () => finish(null));
  child.on("close", (code) => finish(code));
});
function finish(code) {
  if (stopping) return;
  const result = { kind: "result", code };
  if (process.connected) process.send(result, () => stop());
  else stop();
}
// If the parent failed before establishing IPC, do not wait indefinitely.
if (!process.connected) stop();
